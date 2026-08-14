import {
  DIGEST_SCHEMA_VERSION,
  isCategoryId,
  type DigestArticle,
  type DigestReport,
} from '../contracts/digest';

export interface ReportRequirements {
  minArticles: number;
  minSummaryCharacters: number;
  minSummarySentences: number;
  minReasonCharacters: number;
  minHighlightsCharacters: number;
  minKeywordsPerArticle: number;
  maxOtherCategoryRatio: number;
}

export const DEFAULT_REPORT_REQUIREMENTS: Readonly<ReportRequirements> = {
  minArticles: 3,
  minSummaryCharacters: 60,
  minSummarySentences: 3,
  minReasonCharacters: 10,
  minHighlightsCharacters: 20,
  minKeywordsPerArticle: 2,
  maxOtherCategoryRatio: 0.5,
};

export class DigestReportValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`digest report validation failed:\n- ${issues.join('\n- ')}`);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sentenceCount(value: string): number {
  return value.split(/[。！？.!?]+/).filter((part) => part.trim()).length;
}

function validateArticle(
  article: DigestArticle,
  index: number,
  requirements: ReportRequirements,
): string[] {
  const prefix = `articles[${index}]`;
  const issues: string[] = [];
  for (const [field, value] of [
    ['title', article.title],
    ['titleLocalized', article.titleLocalized],
    ['sourceId', article.sourceId],
    ['sourceName', article.sourceName],
    ['summary', article.summary],
    ['reason', article.reason],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) issues.push(`${prefix}.${field} is empty`);
  }
  if (!isHttpUrl(article.url)) issues.push(`${prefix}.url is invalid`);
  if (!isHttpUrl(article.sourceUrl)) issues.push(`${prefix}.sourceUrl is invalid`);
  if (!Number.isFinite(Date.parse(article.publishedAt))) {
    issues.push(`${prefix}.publishedAt is invalid`);
  }
  if (!isCategoryId(article.category)) issues.push(`${prefix}.category is invalid`);
  if (
    !Array.isArray(article.keywords) ||
    article.keywords.length < requirements.minKeywordsPerArticle ||
    article.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim())
  ) {
    issues.push(`${prefix}.keywords does not meet the minimum`);
  }
  if (article.summary.trim().length < requirements.minSummaryCharacters) {
    issues.push(`${prefix}.summary is too short`);
  }
  if (sentenceCount(article.summary) < requirements.minSummarySentences) {
    issues.push(`${prefix}.summary has too few sentences`);
  }
  if (article.reason.trim().length < requirements.minReasonCharacters) {
    issues.push(`${prefix}.reason is too short`);
  }
  for (const [field, value] of Object.entries(article.scores)) {
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      issues.push(`${prefix}.scores.${field} must be an integer from 1 to 10`);
    }
  }
  return issues;
}

export function validateDigestReport(
  report: DigestReport,
  requirements: ReportRequirements = DEFAULT_REPORT_REQUIREMENTS,
): string[] {
  const issues: string[] = [];
  if (report.schemaVersion !== DIGEST_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${DIGEST_SCHEMA_VERSION}`);
  }
  if (!Number.isFinite(Date.parse(report.generatedAt))) issues.push('generatedAt is invalid');
  if (report.language !== 'zh' && report.language !== 'en') issues.push('language is invalid');
  if (report.highlights.trim().length < requirements.minHighlightsCharacters) {
    issues.push('highlights is too short');
  }
  if (report.articles.length < requirements.minArticles) {
    issues.push(`articles must contain at least ${requirements.minArticles} items`);
  }
  report.articles.forEach((article, index) => {
    issues.push(...validateArticle(article, index, requirements));
  });
  const urls = report.articles.map((article) => article.url);
  if (new Set(urls).size !== urls.length) issues.push('articles contain duplicate URLs');
  const otherCount = report.articles.filter((article) => article.category === 'other').length;
  if (report.articles.length > 0 && otherCount / report.articles.length > requirements.maxOtherCategoryRatio) {
    issues.push('too many articles use the other category');
  }
  if (report.stats.selectedArticles !== report.articles.length) {
    issues.push('stats.selectedArticles does not match articles.length');
  }
  if (report.stats.successfulSources > report.stats.configuredSources) {
    issues.push('stats.successfulSources exceeds configuredSources');
  }
  if (report.stats.recentArticles > report.stats.fetchedArticles) {
    issues.push('stats.recentArticles exceeds fetchedArticles');
  }
  return issues;
}

export function assertPublishableDigestReport(
  report: DigestReport,
  requirements: ReportRequirements = DEFAULT_REPORT_REQUIREMENTS,
): void {
  const issues = validateDigestReport(report, requirements);
  if (issues.length > 0) throw new DigestReportValidationError(issues);
}
