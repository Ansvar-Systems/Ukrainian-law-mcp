#!/usr/bin/env tsx
/**
 * Ukrainian Law MCP -- Real legislation ingestion from zakon.rada.gov.ua
 *
 * Strategy:
 * 1. Fetch /print page in Ukrainian for authoritative article text
 * 2. Fetch metadata page with ?lang=en to capture official English title where available
 * 3. Parse article structure from the print page
 * 4. Write deterministic seed files into data/seed/
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import {
  TARGET_LAWS,
  extractEnglishTitle,
  parseLawPrintHtml,
  type ParsedAct,
  type TargetLaw,
} from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORTAL_BASE = 'https://zakon.rada.gov.ua';
const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const SEED_DIR = path.resolve(__dirname, '../data/seed');

interface CliArgs {
  limit: number | null;
  skipFetch: boolean;
}

interface IngestStats {
  processed: number;
  failed: number;
  totalProvisions: number;
  totalDefinitions: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let skipFetch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i++;
      continue;
    }
    if (args[i] === '--skip-fetch') {
      skipFetch = true;
    }
  }

  return { limit, skipFetch };
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

function buildPrintUrl(law: TargetLaw): string {
  return `${PORTAL_BASE}/laws/show/${law.reference}/print`;
}

function buildEnglishMetaUrl(law: TargetLaw): string {
  return `${PORTAL_BASE}/laws/show/${law.reference}?lang=en`;
}

function cacheFilePath(law: TargetLaw, suffix: 'print' | 'en'): string {
  return path.join(SOURCE_DIR, `${law.order}-${law.id}.${suffix}.html`);
}

function seedFilePath(law: TargetLaw): string {
  return path.join(SEED_DIR, `${law.order}-${law.id}.json`);
}

async function fetchLawHtml(law: TargetLaw, skipFetch: boolean): Promise<{ printHtml: string; enHtml: string }> {
  const printPath = cacheFilePath(law, 'print');
  const enPath = cacheFilePath(law, 'en');

  if (skipFetch && fs.existsSync(printPath) && fs.existsSync(enPath)) {
    return {
      printHtml: fs.readFileSync(printPath, 'utf-8'),
      enHtml: fs.readFileSync(enPath, 'utf-8'),
    };
  }

  const printRes = await fetchWithRateLimit(buildPrintUrl(law));
  if (printRes.status !== 200) {
    throw new Error(`Print fetch failed: HTTP ${printRes.status}`);
  }

  const enRes = await fetchWithRateLimit(buildEnglishMetaUrl(law));
  if (enRes.status !== 200) {
    throw new Error(`English metadata fetch failed: HTTP ${enRes.status}`);
  }

  fs.writeFileSync(printPath, printRes.body);
  fs.writeFileSync(enPath, enRes.body);

  return { printHtml: printRes.body, enHtml: enRes.body };
}

async function ingestLaw(law: TargetLaw, skipFetch: boolean): Promise<ParsedAct> {
  const { printHtml, enHtml } = await fetchLawHtml(law, skipFetch);
  const titleEn = extractEnglishTitle(enHtml);
  return parseLawPrintHtml(printHtml, law, titleEn, enHtml);
}

async function main(): Promise<void> {
  const { limit, skipFetch } = parseArgs();
  const laws = limit ? TARGET_LAWS.slice(0, limit) : TARGET_LAWS;

  console.log('Ukrainian Law MCP -- Real Data Ingestion');
  console.log('========================================');
  console.log(`Portal: ${PORTAL_BASE}`);
  console.log(`Laws selected: ${laws.length}`);
  if (limit) console.log(`--limit ${limit}`);
  if (skipFetch) console.log('--skip-fetch');
  console.log('');

  ensureDirs();
  clearExistingSeedFiles();

  const stats: IngestStats = {
    processed: 0,
    failed: 0,
    totalProvisions: 0,
    totalDefinitions: 0,
  };

  for (const law of laws) {
    process.stdout.write(`[${law.order}] ${law.id} (${law.reference}) ... `);

    try {
      const parsed = await ingestLaw(law, skipFetch);
      if (parsed.provisions.length === 0) {
        throw new Error('No provisions extracted');
      }

      const outPath = seedFilePath(law);
      fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));

      stats.processed++;
      stats.totalProvisions += parsed.provisions.length;
      stats.totalDefinitions += parsed.definitions.length;

      console.log(
        `OK (${parsed.provisions.length} provisions, ${parsed.definitions.length} definitions)`,
      );
    } catch (error) {
      stats.failed++;
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`FAILED (${msg})`);
    }
  }

  console.log('\nIngestion Summary');
  console.log('-----------------');
  console.log(`Processed:  ${stats.processed}`);
  console.log(`Failed:     ${stats.failed}`);
  console.log(`Provisions: ${stats.totalProvisions}`);
  console.log(`Definitions:${stats.totalDefinitions}`);
  console.log(`Seed dir:   ${SEED_DIR}`);
}

main().catch(error => {
  console.error('Fatal ingestion error:', error);
  process.exit(1);
});
