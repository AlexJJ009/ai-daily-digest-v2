import { describe, expect, test } from 'bun:test';

import type { DigestReport } from '../../src/contracts/digest';
import {
  assertPublishableDigestReport,
  DigestReportValidationError,
  validateDigestReport,
} from '../../src/validation/digest-report';
import {
  validateScoringOutput,
  validateSummaryOutput,
} from '../../src/validation/model-output';

async function validReport(): Promise<DigestReport> {
  return Bun.file(
    new URL('../fixtures/reports/valid-report.json', import.meta.url),
  ).json();
}

describe('strict model output validation', () => {
  test('accepts complete scoring and summary batches', () => {
    const scores = validateScoringOutput(
      JSON.stringify({
        results: [
          {
            index: 4,
            relevance: 9,
            quality: 8,
            timeliness: 7,
            category: 'engineering',
            keywords: ['reliability', 'inference'],
          },
        ],
      }),
      [4],
    );
    const summaries = validateSummaryOutput(
      JSON.stringify({
        results: [
          { index: 4, titleZh: '可靠推理', summary: '完整摘要。', reason: '明确理由。' },
        ],
      }),
      [4],
    );
    expect(scores[0]!.category).toBe('engineering');
    expect(summaries[0]!.titleLocalized).toBe('可靠推理');
  });

  test('rejects missing indices, invalid scores, empty summaries, and category fallback', () => {
    expect(() => validateScoringOutput('{"results":[]}', [0])).toThrow('each requested index');
    expect(() =>
      validateScoringOutput(
        '{"results":[{"index":0,"relevance":0,"quality":5,"timeliness":5,"category":"other","keywords":["a","b"]}]}',
        [0],
      ),
    ).toThrow('integer from 1 to 10');
    expect(() =>
      validateScoringOutput(
        '{"results":[{"index":0,"relevance":5,"quality":5,"timeliness":5,"category":"unknown","keywords":["a","b"]}]}',
        [0],
      ),
    ).toThrow('invalid category');
    expect(() =>
      validateSummaryOutput(
        '{"results":[{"index":0,"titleZh":"","summary":"","reason":""}]}',
        [0],
      ),
    ).toThrow('non-empty');
  });
});

describe('publication gate', () => {
  test('accepts the canonical complete report', async () => {
    expect(validateDigestReport(await validReport())).toEqual([]);
  });

  test('fails closed for incomplete, duplicate, and low-quality reports', async () => {
    const report = await validReport();
    report.articles[1]!.url = report.articles[0]!.url;
    report.articles[0]!.summary = '';
    report.articles.forEach((article) => {
      article.category = 'other';
    });

    expect(() => assertPublishableDigestReport(report)).toThrow(
      DigestReportValidationError,
    );
    const issues = validateDigestReport(report).join('\n');
    expect(issues).toContain('summary is too short');
    expect(issues).toContain('duplicate URLs');
    expect(issues).toContain('too many articles');
  });
});
