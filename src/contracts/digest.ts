export const DIGEST_SCHEMA_VERSION = 1 as const;

export const CATEGORY_IDS = [
  'ai-ml',
  'security',
  'engineering',
  'tools',
  'opinion',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];
export type DigestLanguage = 'zh' | 'en';

export interface ScoreBreakdown {
  relevance: number;
  quality: number;
  timeliness: number;
}

export interface DigestArticle {
  title: string;
  titleLocalized: string;
  url: string;
  publishedAt: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  category: CategoryId;
  keywords: string[];
  summary: string;
  reason: string;
  scores: ScoreBreakdown;
}

export interface DigestStats {
  configuredSources: number;
  successfulSources: number;
  fetchedArticles: number;
  recentArticles: number;
  selectedArticles: number;
  timeRangeHours: number;
}

export interface DigestReport {
  schemaVersion: typeof DIGEST_SCHEMA_VERSION;
  generatedAt: string;
  language: DigestLanguage;
  highlights: string;
  articles: DigestArticle[];
  stats: DigestStats;
}

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && CATEGORY_IDS.includes(value as CategoryId);
}

export function totalScore(scores: ScoreBreakdown): number {
  return scores.relevance + scores.quality + scores.timeliness;
}
