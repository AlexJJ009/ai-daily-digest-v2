import { describe, expect, test } from 'bun:test';

import {
  CATEGORY_IDS,
  DIGEST_SCHEMA_VERSION,
  isCategoryId,
  totalScore,
  type DigestReport,
} from '../../src/contracts/digest';

async function loadFixture(name: string): Promise<DigestReport> {
  return Bun.file(new URL(`../fixtures/reports/${name}`, import.meta.url)).json();
}

describe('typed digest contract', () => {
  test('keeps category IDs stable and rejects unknown categories', () => {
    expect(CATEGORY_IDS).toEqual([
      'ai-ml',
      'security',
      'engineering',
      'tools',
      'opinion',
      'other',
    ]);
    expect(isCategoryId('ai-ml')).toBe(true);
    expect(isCategoryId('news')).toBe(false);
  });

  test('loads the canonical valid-report fixture', async () => {
    const report = await loadFixture('valid-report.json');

    expect(report.schemaVersion).toBe(DIGEST_SCHEMA_VERSION);
    expect(report.articles).toHaveLength(3);
    expect(report.stats.selectedArticles).toBe(report.articles.length);
    expect(totalScore(report.articles[0]!.scores)).toBe(25);
  });
});
