#!/usr/bin/env tsx
/**
 * Ukrainian Law MCP -- ingestion pipeline
 *
 * Modes:
 * - Curated (default): ingest the maintained 10-law corpus.
 * - Full (--full): ingest full law corpus from official type lists:
 *   - t216 (Constitution)
 *   - t21  (Codes of Ukraine)
 *   - t124 (Codes)
 *   - t1   (Laws)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import {
  TARGET_LAWS,
  buildGenericTargetLaw,
  extractEnglishTitle,
  parseLawPrintHtml,
  slugFromReference,
  type ParsedAct,
  type TargetLaw,
} from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORTAL_BASE = 'https://zakon.rada.gov.ua';
const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const SEED_DIR = path.resolve(__dirname, '../data/seed');

const DEFAULT_FULL_TYPES = ['216', '21', '124', '1'];

interface CliArgs {
  limit: number | null;
  skipFetch: boolean;
  full: boolean;
  resume: boolean;
  fetchEn: boolean;
  cacheHtml: boolean;
  types: string[];
}

interface IngestStats {
  processed: number;
  skipped: number;
  failed: number;
  totalProvisions: number;
  totalDefinitions: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  let limit: number | null = null;
  let skipFetch = false;
  let full = false;
  let resume = false;
  let fetchEn = true;
  let cacheHtml = true;
  let types = [...DEFAULT_FULL_TYPES];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit' && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i++;
      continue;
    }
    if (arg === '--types' && args[i + 1]) {
      types = args[i + 1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      i++;
      continue;
    }
    if (arg === '--skip-fetch') {
      skipFetch = true;
      continue;
    }
    if (arg === '--full') {
      full = true;
      continue;
    }
    if (arg === '--resume') {
      resume = true;
      continue;
    }
    if (arg === '--no-en') {
      fetchEn = false;
      continue;
    }
    if (arg === '--cache-html') {
      cacheHtml = true;
      continue;
    }
    if (arg === '--no-cache-html') {
      cacheHtml = false;
      continue;
    }
  }

  // Full mode defaults
  if (full) {
    if (!args.includes('--no-en') && !args.includes('--fetch-en')) {
      fetchEn = false;
    }
    if (!args.includes('--cache-html') && !args.includes('--no-cache-html')) {
      cacheHtml = false;
    }
  }

  return { limit, skipFetch, full, resume, fetchEn, cacheHtml, types };
}

function ensureDirs(): void {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });
}

function clearExistingSeedFiles(): void {
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (file.endsWith('.json')) {
      fs.unlinkSync(path.join(SEED_DIR, file));
    }
  }
}

function buildPrintUrl(reference: string): string {
  return `${PORTAL_BASE}/laws/show/${reference}/print`;
}

function buildEnglishMetaUrl(reference: string): string {
  return `${PORTAL_BASE}/laws/show/${reference}?lang=en`;
}

function lawCacheFilePath(law: TargetLaw, suffix: 'print' | 'en'): string {
  const refSlug = slugFromReference(law.reference);
  return path.join(SOURCE_DIR, `${law.order}-${refSlug}.${suffix}.html`);
}

function seedFilePath(law: TargetLaw): string {
  return path.join(SEED_DIR, `${law.order}-${law.id}.json`);
}

async function fetchLawHtml(
  law: TargetLaw,
  options: { skipFetch: boolean; fetchEn: boolean; cacheHtml: boolean },
): Promise<{ printHtml: string; enHtml: string }> {
  const printPath = lawCacheFilePath(law, 'print');
  const enPath = lawCacheFilePath(law, 'en');

  if (options.skipFetch) {
    if (!fs.existsSync(printPath)) {
      throw new Error(`Missing cached print HTML for ${law.reference}`);
    }
    const printHtml = fs.readFileSync(printPath, 'utf-8');
    const enHtml =
      options.fetchEn && fs.existsSync(enPath)
        ? fs.readFileSync(enPath, 'utf-8')
        : '';
    return { printHtml, enHtml };
  }

  const printRes = await fetchWithRateLimit(buildPrintUrl(law.reference));
  if (printRes.status !== 200) {
    throw new Error(`Print fetch failed: HTTP ${printRes.status}`);
  }

  let enHtml = '';
  if (options.fetchEn) {
    const enRes = await fetchWithRateLimit(buildEnglishMetaUrl(law.reference));
    if (enRes.status !== 200) {
      throw new Error(`English metadata fetch failed: HTTP ${enRes.status}`);
    }
    enHtml = enRes.body;
  }

  if (options.cacheHtml) {
    fs.writeFileSync(printPath, printRes.body);
    if (options.fetchEn) fs.writeFileSync(enPath, enHtml);
  }

  return { printHtml: printRes.body, enHtml };
}

function ensureUniqueLawIds(laws: TargetLaw[]): TargetLaw[] {
  const seen = new Map<string, number>();
  return laws.map(law => {
    const current = seen.get(law.id) ?? 0;
    seen.set(law.id, current + 1);
    if (current === 0) return law;

    return {
      ...law,
      id: `${law.id}-${current + 1}`,
    };
  });
}

async function fetchReferencesForType(typeId: string): Promise<string[]> {
  const url = `${PORTAL_BASE}/laws/main/t${typeId}.txt`;
  const res = await fetchWithRateLimit(url);
  if (res.status !== 200) {
    throw new Error(`Could not fetch type list t${typeId}: HTTP ${res.status}`);
  }

  return res.body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('<'));
}

async function buildFullLawList(types: string[]): Promise<TargetLaw[]> {
  const refs: string[] = [];
  const seenRefs = new Set<string>();

  for (const typeId of types) {
    const typeRefs = await fetchReferencesForType(typeId);
    for (const ref of typeRefs) {
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      refs.push(ref);
    }
  }

  const generated = refs.map((reference, idx) => {
    const order = String(idx + 1).padStart(5, '0');
    return buildGenericTargetLaw(reference, order);
  });

  return ensureUniqueLawIds(generated);
}

async function ingestOneLaw(
  law: TargetLaw,
  options: { skipFetch: boolean; fetchEn: boolean; cacheHtml: boolean; extractDefinitions: boolean },
): Promise<ParsedAct> {
  const { printHtml, enHtml } = await fetchLawHtml(law, options);
  const titleEn = options.fetchEn ? extractEnglishTitle(enHtml) : undefined;
  return parseLawPrintHtml(
    printHtml,
    law,
    titleEn,
    enHtml || printHtml,
    { extractDefinitions: options.extractDefinitions },
  );
}

function appendFailureLog(message: string): void {
  const logPath = path.join(SOURCE_DIR, 'ingest-failures.log');
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

async function runIngestion(laws: TargetLaw[], args: CliArgs): Promise<void> {
  const stats: IngestStats = {
    processed: 0,
    skipped: 0,
    failed: 0,
    totalProvisions: 0,
    totalDefinitions: 0,
  };

  const extractDefinitions = !args.full;

  for (let i = 0; i < laws.length; i++) {
    const law = laws[i];
    const seedPath = seedFilePath(law);

    if (args.resume && fs.existsSync(seedPath)) {
      stats.skipped++;
      if ((i + 1) % 100 === 0) {
        console.log(
          `[${i + 1}/${laws.length}] resume-skip=${stats.skipped} processed=${stats.processed} failed=${stats.failed}`,
        );
      }
      continue;
    }

    try {
      const parsed = await ingestOneLaw(law, {
        skipFetch: args.skipFetch,
        fetchEn: args.fetchEn,
        cacheHtml: args.cacheHtml,
        extractDefinitions,
      });

      if (parsed.provisions.length === 0) {
        throw new Error('No provisions extracted');
      }

      fs.writeFileSync(seedPath, JSON.stringify(parsed, null, 2));
      stats.processed++;
      stats.totalProvisions += parsed.provisions.length;
      stats.totalDefinitions += parsed.definitions.length;
    } catch (error) {
      stats.failed++;
      const msg = error instanceof Error ? error.message : String(error);
      appendFailureLog(`${law.reference} (${law.id}): ${msg}`);

      // Keep progress logs readable for long full-corpus runs.
      if (stats.failed <= 20 || stats.failed % 50 === 0) {
        console.log(`[FAIL] ${law.reference} (${law.id}) -> ${msg}`);
      }
    }

    if ((i + 1) % 50 === 0 || i === laws.length - 1) {
      console.log(
        `[${i + 1}/${laws.length}] processed=${stats.processed} skipped=${stats.skipped} failed=${stats.failed} provisions=${stats.totalProvisions}`,
      );
    }
  }

  console.log('\nIngestion Summary');
  console.log('-----------------');
  console.log(`Total selected: ${laws.length}`);
  console.log(`Processed:      ${stats.processed}`);
  console.log(`Skipped:        ${stats.skipped}`);
  console.log(`Failed:         ${stats.failed}`);
  console.log(`Provisions:     ${stats.totalProvisions}`);
  console.log(`Definitions:    ${stats.totalDefinitions}`);
  console.log(`Seed dir:       ${SEED_DIR}`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('Ukrainian Law MCP -- Ingestion Pipeline');
  console.log('=======================================');
  console.log(`Portal: ${PORTAL_BASE}`);
  console.log(`Mode:   ${args.full ? 'FULL' : 'CURATED'}`);
  console.log(`Rate:   MCP_FETCH_DELAY_MS=${process.env.MCP_FETCH_DELAY_MS ?? '1200 (default)'}`);
  console.log(`fetchEn=${args.fetchEn} cacheHtml=${args.cacheHtml} resume=${args.resume}`);
  if (args.limit) console.log(`limit=${args.limit}`);
  if (args.full) console.log(`types=${args.types.join(',')}`);
  console.log('');

  ensureDirs();

  let laws: TargetLaw[];
  if (args.full) {
    laws = await buildFullLawList(args.types);
  } else {
    laws = [...TARGET_LAWS];
  }

  if (args.limit) {
    laws = laws.slice(0, args.limit);
  }

  if (!args.resume) {
    clearExistingSeedFiles();
  }

  await runIngestion(laws, args);
}

main().catch(error => {
  console.error('Fatal ingestion error:', error);
  process.exit(1);
});
