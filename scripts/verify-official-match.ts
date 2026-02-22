#!/usr/bin/env tsx
/**
 * Verifies DB provision text against official zakon.rada.gov.ua print text.
 * Compares provision content character-by-character for selected targets.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit } from './lib/fetcher.js';
import { parseLawPrintHtml, type TargetLaw } from './lib/parser.js';

interface VerificationTarget {
  documentId: string;
  reference: string;
  section: string;
  titleUkFallback: string;
  shortName: string;
  titleEnFallback: string;
}

interface VerificationResult {
  documentId: string;
  reference: string;
  section: string;
  status: 'MATCH' | 'MISMATCH' | 'MISSING_DB' | 'MISSING_SOURCE' | 'FETCH_ERROR';
  details: string;
}

const TARGETS: VerificationTarget[] = [
  {
    documentId: 'ua-personal-data-protection',
    reference: '2297-17',
    section: '1',
    titleUkFallback: 'Про захист персональних даних',
    shortName: 'ЗУ ПД',
    titleEnFallback: 'On Protection of Personal Data',
  },
  {
    documentId: 'ua-access-public-information',
    reference: '2939-17',
    section: '5',
    titleUkFallback: 'Про доступ до публічної інформації',
    shortName: 'ЗУ ДПІ',
    titleEnFallback: 'On Access to Public Information',
  },
  {
    documentId: 'ua-electronic-trust-services',
    reference: '2155-19',
    section: '10',
    titleUkFallback: 'Про електронну ідентифікацію та електронні довірчі послуги',
    shortName: 'ЗУ ЕДП',
    titleEnFallback: 'On Electronic Identification and Electronic Trust Services',
  },
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.db');

function firstDiffIndex(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

function buildLawTarget(target: VerificationTarget): TargetLaw {
  return {
    order: '00',
    id: target.documentId,
    reference: target.reference,
    titleUkFallback: target.titleUkFallback,
    shortName: target.shortName,
    titleEnFallback: target.titleEnFallback,
    description: 'Verification target',
  };
}

async function verifyOne(db: Database.Database, target: VerificationTarget): Promise<VerificationResult> {
  const printUrl = `https://zakon.rada.gov.ua/laws/show/${target.reference}/print`;
  const fetchRes = await fetchWithRateLimit(printUrl);
  if (fetchRes.status !== 200) {
    return {
      documentId: target.documentId,
      reference: target.reference,
      section: target.section,
      status: 'FETCH_ERROR',
      details: `HTTP ${fetchRes.status} for ${printUrl}`,
    };
  }

  const parsed = parseLawPrintHtml(
    fetchRes.body,
    buildLawTarget(target),
    undefined,
    fetchRes.body,
    { extractDefinitions: false },
  );

  const sourceProvision = parsed.provisions.find(p => p.section === target.section);
  if (!sourceProvision) {
    return {
      documentId: target.documentId,
      reference: target.reference,
      section: target.section,
      status: 'MISSING_SOURCE',
      details: `Section ${target.section} not found in official source parse`,
    };
  }

  const dbRow = db.prepare(
    'SELECT content FROM legal_provisions WHERE document_id = ? AND section = ?',
  ).get(target.documentId, target.section) as { content: string } | undefined;

  if (!dbRow) {
    return {
      documentId: target.documentId,
      reference: target.reference,
      section: target.section,
      status: 'MISSING_DB',
      details: `Section ${target.section} not found in database`,
    };
  }

  if (dbRow.content === sourceProvision.content) {
    return {
      documentId: target.documentId,
      reference: target.reference,
      section: target.section,
      status: 'MATCH',
      details: `Exact match (${dbRow.content.length} chars)`,
    };
  }

  const diffIndex = firstDiffIndex(dbRow.content, sourceProvision.content);
  return {
    documentId: target.documentId,
    reference: target.reference,
    section: target.section,
    status: 'MISMATCH',
    details: `First diff at char ${diffIndex}; db=${dbRow.content.length} chars, source=${sourceProvision.content.length} chars`,
  };
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const results: VerificationResult[] = [];
    for (const target of TARGETS) {
      const result = await verifyOne(db, target);
      results.push(result);
    }

    for (const result of results) {
      console.log(
        `${result.documentId} section ${result.section} (${result.reference}): ${result.status} -- ${result.details}`,
      );
    }

    const allMatch = results.every(r => r.status === 'MATCH');
    if (!allMatch) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error('Verification failed:', error);
  process.exit(1);
});
