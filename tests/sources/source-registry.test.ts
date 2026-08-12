import { describe, expect, test } from 'bun:test';

import { parseFeedItems } from '../../src/sources/feed';
import {
  assertSourceCoverage,
  buildSourceHealthReport,
  SourceCoverageError,
} from '../../src/sources/health';
import {
  loadSourceRegistry,
  loadSourceThresholds,
  SourceRegistryError,
  validateSourceRegistry,
} from '../../src/sources/registry';

describe('source registry', () => {
  test('loads the audited config with explicit status and reason', async () => {
    const registry = await loadSourceRegistry();
    expect(registry.sources.length).toBeGreaterThan(80);
    expect(registry.sources.every((source) => source.status && source.reason)).toBe(true);
  });

  test('rejects duplicate feed URLs and incomplete entries', () => {
    const source = {
      id: 'fixture',
      name: 'Fixture',
      feedUrl: 'https://example.com/feed',
      siteUrl: 'https://example.com',
      status: 'active',
      reason: 'Fixture source.',
    };
    expect(() => validateSourceRegistry({ schemaVersion: 1, sources: [source, { ...source, id: 'duplicate' }] })).toThrow(
      'duplicate feedUrl',
    );
    expect(() => validateSourceRegistry({ schemaVersion: 1, sources: [{ ...source, reason: '' }] })).toThrow(
      SourceRegistryError,
    );
  });

  test('parses an RSS fixture', async () => {
    const xml = await Bun.file(new URL('../fixtures/feeds/rss.xml', import.meta.url)).text();
    expect(parseFeedItems(xml)).toEqual([
      {
        title: 'Typed & tested feeds',
        link: 'https://example.com/post-1',
        publishedAt: 'Wed, 12 Aug 2026 06:00:00 GMT',
        description: 'A fixture-backed RSS article.',
      },
    ]);
  });
});

describe('source health and thresholds', () => {
  const registry = validateSourceRegistry({
    schemaVersion: 1,
    sources: [
      { id: 'one', name: 'One', feedUrl: 'https://one.example/feed', siteUrl: 'https://one.example', status: 'active', reason: 'Fixture active source.' },
      { id: 'two', name: 'Two', feedUrl: 'https://two.example/feed', siteUrl: 'https://two.example', status: 'active', reason: 'Fixture active source.' },
      { id: 'old', name: 'Old', feedUrl: 'https://old.example/feed', siteUrl: 'https://old.example', status: 'deprecated', reason: 'Fixture deprecation.' },
    ],
  });

  test('reports single-feed degradation while allowing configured coverage', () => {
    const report = buildSourceHealthReport(
      registry,
      [
        { sourceId: 'one', status: 'success', articleCount: 4 },
        { sourceId: 'two', status: 'failed', articleCount: 0, error: 'HTTP 503' },
      ],
      3,
      { minimumCoverageRatio: 0.5, minimumRecentArticles: 3 },
      '2026-08-12T08:00:00.000Z',
    );
    expect(report).toMatchObject({
      successfulSources: 1,
      failedSources: 1,
      deprecatedSources: 1,
      coverageRatio: 0.5,
      meetsThresholds: true,
    });
    expect(report.sources.find((source) => source.sourceId === 'two')?.error).toBe('HTTP 503');
    expect(() => assertSourceCoverage(report)).not.toThrow();
  });

  test('fails closed below source or article thresholds', () => {
    const report = buildSourceHealthReport(
      registry,
      [
        { sourceId: 'one', status: 'success', articleCount: 1 },
        { sourceId: 'two', status: 'failed', articleCount: 0, error: 'timeout' },
      ],
      1,
      { minimumCoverageRatio: 0.75, minimumRecentArticles: 3 },
    );
    expect(() => assertSourceCoverage(report)).toThrow(SourceCoverageError);
  });

  test('validates configurable defaults and overrides', () => {
    expect(loadSourceThresholds({})).toEqual({
      minimumCoverageRatio: 0.5,
      minimumRecentArticles: 3,
    });
    expect(
      loadSourceThresholds({
        MIN_SOURCE_COVERAGE_RATIO: '0.8',
        MIN_RECENT_ARTICLES: '7',
      }),
    ).toEqual({ minimumCoverageRatio: 0.8, minimumRecentArticles: 7 });
    expect(() => loadSourceThresholds({ MIN_SOURCE_COVERAGE_RATIO: '2' })).toThrow(
      'between 0 and 1',
    );
  });
});
