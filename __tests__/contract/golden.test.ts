/**
 * Golden contract tests for Ukrainian Law MCP.
 * Validates core tool functionality against seed data.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../../data/database.db');

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = DELETE');
});

describe('Database integrity', () => {
  it('should have at least 10 legal documents', () => {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM legal_documents'
    ).get() as { cnt: number };
    expect(row.cnt).toBeGreaterThanOrEqual(10);
  });

  it('should have at least 112 provisions', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM legal_provisions').get() as { cnt: number };
    expect(row.cnt).toBeGreaterThanOrEqual(112);
  });

  it('should have FTS index', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM provisions_fts WHERE provisions_fts MATCH 'data'"
    ).get() as { cnt: number };
    expect(row.cnt).toBeGreaterThanOrEqual(0);
  });
});

describe('Article retrieval', () => {
  it('should retrieve a provision by document_id and section', () => {
    const row = db.prepare(
      "SELECT content FROM legal_provisions WHERE document_id = 'ua-access-public-information' AND section = '1'"
    ).get() as { content: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.content.length).toBeGreaterThan(50);
  });
});

describe('Search', () => {
  it('should find results via FTS search', () => {
    const rows = db.prepare(
      "SELECT COUNT(*) as cnt FROM provisions_fts WHERE provisions_fts MATCH 'персональних'"
    ).get() as { cnt: number };
    expect(rows.cnt).toBeGreaterThan(0);
  });
});

describe('EU cross-references', () => {
  it('should query EU document references table', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM eu_documents').get() as { cnt: number };
    expect(row.cnt).toBeGreaterThanOrEqual(0);
  });

  it('should query EU reference links table', () => {
    const rows = db.prepare(
      "SELECT eu_document_id FROM eu_references WHERE document_id = 'ua-cybersecurity'"
    ).all() as { eu_document_id: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Negative tests', () => {
  it('should return no results for fictional document', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM legal_provisions WHERE document_id = 'fictional-law-2099'"
    ).get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it('should return no results for invalid section', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM legal_provisions WHERE document_id = 'ua-access-public-information' AND section = '999ZZZ-INVALID'"
    ).get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});

describe('All 10 laws are present', () => {
  const expectedDocs = [
    'ua-access-public-information',
    'ua-competition-trade-secrets',
    'ua-criminal-code-cybercrime',
    'ua-critical-infrastructure',
    'ua-cybersecurity',
    'ua-electronic-commerce',
    'ua-electronic-communications',
    'ua-electronic-trust-services',
    'ua-information-protection-systems',
    'ua-personal-data-protection',
  ];

  for (const docId of expectedDocs) {
    it(`should contain document: ${docId}`, () => {
      const row = db.prepare(
        'SELECT id FROM legal_documents WHERE id = ?'
      ).get(docId) as { id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe(docId);
    });
  }
});

describe('Provision coverage by law', () => {
  const minimumCounts: Record<string, number> = {
    'ua-personal-data-protection': 1,
    'ua-cybersecurity': 1,
    'ua-electronic-communications': 1,
    'ua-electronic-commerce': 1,
    'ua-electronic-trust-services': 1,
    'ua-access-public-information': 1,
    'ua-criminal-code-cybercrime': 6,
    'ua-critical-infrastructure': 1,
    'ua-information-protection-systems': 1,
    'ua-competition-trade-secrets': 1,
  };

  for (const [docId, minimum] of Object.entries(minimumCounts)) {
    it(`should keep non-empty provision coverage for ${docId}`, () => {
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM legal_provisions WHERE document_id = ?'
      ).get(docId) as { cnt: number };
      expect(row.cnt).toBeGreaterThanOrEqual(minimum);
    });
  }
});

describe('list_sources', () => {
  it('should have db_metadata table', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM db_metadata').get() as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });
});
