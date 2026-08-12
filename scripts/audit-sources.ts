import { parseFeedItems } from '../src/sources/feed';
import {
  assertSourceCoverage,
  buildSourceHealthReport,
  type SourceFetchResult,
} from '../src/sources/health';
import {
  loadSourceRegistry,
  loadSourceThresholds,
  type SourceDefinition,
} from '../src/sources/registry';

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 10;
const auditHours = Number(process.env.SOURCE_AUDIT_HOURS ?? '48');
if (!Number.isInteger(auditHours) || auditHours < 1) {
  throw new Error('SOURCE_AUDIT_HOURS must be a positive integer');
}

async function audit(source: SourceDefinition): Promise<{
  result: SourceFetchResult;
  recentArticles: number;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(source.feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-Daily-Digest/2.0 (Source Audit)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = parseFeedItems(await response.text());
    if (items.length === 0) throw new Error('feed contained no RSS/Atom items');
    const cutoff = Date.now() - auditHours * 60 * 60 * 1000;
    return {
      result: { sourceId: source.id, status: 'success', articleCount: items.length },
      recentArticles: items.filter((item) => Date.parse(item.publishedAt) > cutoff).length,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.includes('abort') ? 'timeout' : raw;
    return {
      result: { sourceId: source.id, status: 'failed', articleCount: 0, error: message },
      recentArticles: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const registry = await loadSourceRegistry();
const activeSources = registry.sources.filter((source) => source.status === 'active');
const outcomes: Awaited<ReturnType<typeof audit>>[] = [];
for (let index = 0; index < activeSources.length; index += CONCURRENCY) {
  outcomes.push(...(await Promise.all(activeSources.slice(index, index + CONCURRENCY).map(audit))));
}
const report = buildSourceHealthReport(
  registry,
  outcomes.map((outcome) => outcome.result),
  outcomes.reduce((sum, outcome) => sum + outcome.recentArticles, 0),
  loadSourceThresholds(),
);
console.log(JSON.stringify(report, null, 2));
assertSourceCoverage(report);
