import type {
  SourceDefinition,
  SourceRegistry,
  SourceThresholds,
} from './registry';

export interface SourceFetchResult {
  sourceId: string;
  status: 'success' | 'failed';
  articleCount: number;
  error?: string;
}

export interface SourceHealthEntry {
  sourceId: string;
  name: string;
  registryStatus: 'active' | 'deprecated';
  health: 'healthy' | 'failed' | 'deprecated';
  articleCount: number;
  reason: string;
  error?: string;
}

export interface SourceHealthReport {
  schemaVersion: 1;
  generatedAt: string;
  configuredSources: number;
  activeSources: number;
  deprecatedSources: number;
  successfulSources: number;
  failedSources: number;
  coverageRatio: number;
  recentArticles: number;
  thresholds: SourceThresholds;
  meetsThresholds: boolean;
  sources: SourceHealthEntry[];
}

export class SourceCoverageError extends Error {}

function entry(source: SourceDefinition, result?: SourceFetchResult): SourceHealthEntry {
  if (source.status === 'deprecated') {
    return {
      sourceId: source.id,
      name: source.name,
      registryStatus: source.status,
      health: 'deprecated',
      articleCount: 0,
      reason: source.reason,
    };
  }
  if (!result) throw new Error(`missing fetch result for ${source.id}`);
  return {
    sourceId: source.id,
    name: source.name,
    registryStatus: source.status,
    health: result.status === 'success' ? 'healthy' : 'failed',
    articleCount: result.articleCount,
    reason: source.reason,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function buildSourceHealthReport(
  registry: SourceRegistry,
  results: readonly SourceFetchResult[],
  recentArticles: number,
  thresholds: SourceThresholds,
  generatedAt = new Date().toISOString(),
): SourceHealthReport {
  const byId = new Map(results.map((result) => [result.sourceId, result]));
  if (byId.size !== results.length) throw new Error('duplicate source fetch result');
  const sources = registry.sources.map((source) => entry(source, byId.get(source.id)));
  const activeSources = sources.filter((source) => source.registryStatus === 'active').length;
  const deprecatedSources = sources.length - activeSources;
  const successfulSources = sources.filter((source) => source.health === 'healthy').length;
  const failedSources = sources.filter((source) => source.health === 'failed').length;
  const coverageRatio = activeSources === 0 ? 0 : successfulSources / activeSources;
  return {
    schemaVersion: 1,
    generatedAt,
    configuredSources: sources.length,
    activeSources,
    deprecatedSources,
    successfulSources,
    failedSources,
    coverageRatio,
    recentArticles,
    thresholds,
    meetsThresholds:
      coverageRatio >= thresholds.minimumCoverageRatio &&
      recentArticles >= thresholds.minimumRecentArticles,
    sources,
  };
}

export function assertSourceCoverage(report: SourceHealthReport): void {
  if (!report.meetsThresholds) {
    throw new SourceCoverageError(
      `source coverage gate failed: coverage=${report.coverageRatio.toFixed(3)} ` +
        `(minimum=${report.thresholds.minimumCoverageRatio}), recentArticles=${report.recentArticles} ` +
        `(minimum=${report.thresholds.minimumRecentArticles})`,
    );
  }
}
