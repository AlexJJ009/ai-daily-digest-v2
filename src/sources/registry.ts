export type SourceStatus = 'active' | 'deprecated';

export interface SourceDefinition {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string;
  status: SourceStatus;
  reason: string;
}

export interface SourceRegistry {
  schemaVersion: 1;
  sources: SourceDefinition[];
}

export interface SourceThresholds {
  minimumCoverageRatio: number;
  minimumRecentArticles: number;
}

export const DEFAULT_SOURCE_THRESHOLDS: Readonly<SourceThresholds> = {
  minimumCoverageRatio: 0.5,
  minimumRecentArticles: 3,
};

export class SourceRegistryError extends Error {}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateSourceRegistry(value: unknown): SourceRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceRegistryError('source registry must be an object');
  }
  const registry = value as Record<string, unknown>;
  if (registry.schemaVersion !== 1) {
    throw new SourceRegistryError('source registry schemaVersion must be 1');
  }
  if (!Array.isArray(registry.sources) || registry.sources.length === 0) {
    throw new SourceRegistryError('source registry must contain sources');
  }

  const sources = registry.sources.map((value, index): SourceDefinition => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SourceRegistryError(`sources[${index}] must be an object`);
    }
    const source = value as Record<string, unknown>;
    for (const field of ['id', 'name', 'reason'] as const) {
      if (typeof source[field] !== 'string' || !source[field].trim()) {
        throw new SourceRegistryError(`sources[${index}].${field} is required`);
      }
    }
    if (!httpUrl(source.feedUrl)) {
      throw new SourceRegistryError(`sources[${index}].feedUrl is invalid`);
    }
    if (!httpUrl(source.siteUrl)) {
      throw new SourceRegistryError(`sources[${index}].siteUrl is invalid`);
    }
    if (source.status !== 'active' && source.status !== 'deprecated') {
      throw new SourceRegistryError(`sources[${index}].status is invalid`);
    }
    return {
      id: (source.id as string).trim(),
      name: (source.name as string).trim(),
      feedUrl: source.feedUrl,
      siteUrl: source.siteUrl,
      status: source.status,
      reason: (source.reason as string).trim(),
    };
  });

  for (const [field, values] of [
    ['id', sources.map((source) => source.id)],
    ['feedUrl', sources.map((source) => source.feedUrl)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new SourceRegistryError(`source registry contains duplicate ${field}`);
    }
  }
  if (!sources.some((source) => source.status === 'active')) {
    throw new SourceRegistryError('source registry has no active sources');
  }
  return { schemaVersion: 1, sources };
}

export async function loadSourceRegistry(
  path = new URL('../../config/sources.json', import.meta.url),
): Promise<SourceRegistry> {
  return validateSourceRegistry(await Bun.file(path).json());
}

function numberSetting(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new SourceRegistryError(`${name} must be numeric`);
  return parsed;
}

export function loadSourceThresholds(
  env: Record<string, string | undefined> = process.env,
): SourceThresholds {
  const minimumCoverageRatio = numberSetting(
    env.MIN_SOURCE_COVERAGE_RATIO,
    DEFAULT_SOURCE_THRESHOLDS.minimumCoverageRatio,
    'MIN_SOURCE_COVERAGE_RATIO',
  );
  const minimumRecentArticles = numberSetting(
    env.MIN_RECENT_ARTICLES,
    DEFAULT_SOURCE_THRESHOLDS.minimumRecentArticles,
    'MIN_RECENT_ARTICLES',
  );
  if (minimumCoverageRatio < 0 || minimumCoverageRatio > 1) {
    throw new SourceRegistryError('MIN_SOURCE_COVERAGE_RATIO must be between 0 and 1');
  }
  if (!Number.isInteger(minimumRecentArticles) || minimumRecentArticles < 1) {
    throw new SourceRegistryError('MIN_RECENT_ARTICLES must be a positive integer');
  }
  return { minimumCoverageRatio, minimumRecentArticles };
}
