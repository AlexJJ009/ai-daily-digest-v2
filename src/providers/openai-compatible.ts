export type OpenAIApiStyle = 'responses' | 'chat_completions';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiStyle: OpenAIApiStyle;
  responsesPath: string;
  chatCompletionsPath: string;
}

export interface OpenAICompatibleClient {
  call(prompt: string): Promise<string>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderRuntime {
  fetch: FetchLike;
  sleep(milliseconds: number): Promise<void>;
  maxAttempts: number;
  retryDelayMs: number;
}

export class ProviderConfigError extends Error {}
export class ProviderResponseError extends Error {}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ProviderConfigError(`${name} is required`);
  return normalized;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const path = value?.trim() || fallback;
  return path.startsWith('/') ? path : `/${path}`;
}

export function loadOpenAICompatibleConfig(
  env: Record<string, string | undefined> = process.env,
): OpenAICompatibleConfig {
  const apiStyle = env.OPENAI_API_STYLE?.trim() || 'responses';
  if (apiStyle !== 'responses' && apiStyle !== 'chat_completions') {
    throw new ProviderConfigError(
      'OPENAI_API_STYLE must be responses or chat_completions',
    );
  }

  return {
    apiKey: required(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
    baseUrl: (env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
    apiStyle,
    responsesPath: normalizePath(env.OPENAI_RESPONSES_PATH, '/responses'),
    chatCompletionsPath: normalizePath(
      env.OPENAI_CHAT_COMPLETIONS_PATH,
      '/chat/completions',
    ),
  };
}

function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text.trim();
  if (!Array.isArray(record.output)) return '';

  const fragments: string[] = [];
  for (const output of record.output) {
    if (!output || typeof output !== 'object') continue;
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (
        (value.type === 'output_text' || value.type === 'text') &&
        typeof value.text === 'string'
      ) {
        fragments.push(value.text);
      }
    }
  }
  return fragments.join('\n').trim();
}

function extractChatCompletionsText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter(
      (item): item is { type: string; text: string } =>
        Boolean(
          item &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).type === 'text' &&
            typeof (item as Record<string, unknown>).text === 'string',
        ),
    )
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function createOpenAICompatibleClient(
  config: OpenAICompatibleConfig,
  runtime: Partial<ProviderRuntime> = {},
): OpenAICompatibleClient {
  const resolvedRuntime: ProviderRuntime = {
    fetch: runtime.fetch ?? fetch,
    sleep: runtime.sleep ?? ((milliseconds) => Bun.sleep(milliseconds)),
    maxAttempts: runtime.maxAttempts ?? 3,
    retryDelayMs: runtime.retryDelayMs ?? 250,
  };
  if (resolvedRuntime.maxAttempts < 1) {
    throw new ProviderConfigError('maxAttempts must be at least 1');
  }

  const path =
    config.apiStyle === 'responses'
      ? config.responsesPath
      : config.chatCompletionsPath;
  const endpoint = `${config.baseUrl}${path}`;

  return {
    async call(prompt: string): Promise<string> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= resolvedRuntime.maxAttempts; attempt++) {
        try {
          const body =
            config.apiStyle === 'responses'
              ? { model: config.model, input: prompt, temperature: 0.3, top_p: 0.8 }
              : {
                  model: config.model,
                  messages: [{ role: 'user', content: prompt }],
                  temperature: 0.3,
                  top_p: 0.8,
                };
          const response = await resolvedRuntime.fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const responseBody = await response.text().catch(() => '');
            const error = new ProviderResponseError(
              `OpenAI-compatible API returned ${response.status}${
                responseBody ? `: ${responseBody.slice(0, 300)}` : ''
              }`,
            );
            if (!retryableStatus(response.status) || attempt === resolvedRuntime.maxAttempts) {
              throw error;
            }
            lastError = error;
          } else {
            const payload: unknown = await response.json();
            const text =
              config.apiStyle === 'responses'
                ? extractResponsesText(payload)
                : extractChatCompletionsText(payload);
            if (!text) {
              throw new ProviderResponseError(
                `${config.apiStyle} response did not contain output text`,
              );
            }
            return text;
          }
        } catch (error) {
          lastError = error;
          if (error instanceof ProviderResponseError || attempt === resolvedRuntime.maxAttempts) {
            throw error;
          }
        }
        await resolvedRuntime.sleep(resolvedRuntime.retryDelayMs * attempt);
      }
      throw lastError instanceof Error
        ? lastError
        : new ProviderResponseError('OpenAI-compatible request failed');
    },
  };
}
