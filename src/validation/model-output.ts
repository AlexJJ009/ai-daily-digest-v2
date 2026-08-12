import { isCategoryId, type CategoryId } from '../contracts/digest';

export interface ScoringResult {
  index: number;
  relevance: number;
  quality: number;
  timeliness: number;
  category: CategoryId;
  keywords: string[];
}

export interface SummaryResult {
  index: number;
  titleLocalized: string;
  summary: string;
  reason: string;
}

export class ModelOutputError extends Error {}

export function parseJsonObject(text: string): Record<string, unknown> {
  let value = text.trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ModelOutputError(
      `model output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelOutputError('model output must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function exactIndexedResults(
  payload: Record<string, unknown>,
  expectedIndices: readonly number[],
): Record<string, unknown>[] {
  if (!Array.isArray(payload.results)) {
    throw new ModelOutputError('results must be an array');
  }
  const results = payload.results.map((result, position) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ModelOutputError(`results[${position}] must be an object`);
    }
    return result as Record<string, unknown>;
  });
  const actualIndices = results.map((result) => result.index);
  if (
    results.length !== expectedIndices.length ||
    actualIndices.some((value) => !Number.isInteger(value)) ||
    new Set(actualIndices).size !== actualIndices.length ||
    expectedIndices.some((index) => !actualIndices.includes(index))
  ) {
    throw new ModelOutputError(
      `results must contain each requested index exactly once; expected ${expectedIndices.join(',')}`,
    );
  }
  return results;
}

function score(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) {
    throw new ModelOutputError(`${field} must be an integer from 1 to 10`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ModelOutputError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function validateScoringOutput(
  text: string,
  expectedIndices: readonly number[],
): ScoringResult[] {
  return exactIndexedResults(parseJsonObject(text), expectedIndices).map((result) => {
    if (!isCategoryId(result.category)) {
      throw new ModelOutputError(`result ${String(result.index)} has an invalid category`);
    }
    if (
      !Array.isArray(result.keywords) ||
      result.keywords.length < 2 ||
      result.keywords.length > 4 ||
      result.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim())
    ) {
      throw new ModelOutputError(
        `result ${String(result.index)} must contain 2 to 4 non-empty keywords`,
      );
    }
    return {
      index: result.index as number,
      relevance: score(result.relevance, 'relevance'),
      quality: score(result.quality, 'quality'),
      timeliness: score(result.timeliness, 'timeliness'),
      category: result.category,
      keywords: result.keywords.map((keyword) => (keyword as string).trim()),
    };
  });
}

export function validateSummaryOutput(
  text: string,
  expectedIndices: readonly number[],
): SummaryResult[] {
  return exactIndexedResults(parseJsonObject(text), expectedIndices).map((result) => ({
    index: result.index as number,
    titleLocalized: nonEmptyString(result.titleZh, 'titleZh'),
    summary: nonEmptyString(result.summary, 'summary'),
    reason: nonEmptyString(result.reason, 'reason'),
  }));
}
