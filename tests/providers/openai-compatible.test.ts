import { describe, expect, test } from 'bun:test';

import {
  createOpenAICompatibleClient,
  loadOpenAICompatibleConfig,
  ProviderConfigError,
} from '../../src/providers/openai-compatible';

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`../fixtures/providers/${name}`, import.meta.url)).text();
}

describe('OpenAI-compatible provider', () => {
  test('supports Responses with a custom base URL, path, model, and key', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const config = loadOpenAICompatibleConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1/',
      OPENAI_MODEL: 'fixture-model',
      OPENAI_API_STYLE: 'responses',
      OPENAI_RESPONSES_PATH: 'custom/responses',
    });
    const client = createOpenAICompatibleClient(config, {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(await fixture('responses.json'), { status: 200 });
      },
    });

    expect(await client.call('score these')).toBe('{"results":[]}');
    expect(requests[0]!.url).toBe('https://gateway.example/v1/custom/responses');
    expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({
      model: 'fixture-model',
      input: 'score these',
    });
    expect((requests[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fixture-key',
    );
  });

  test('supports Chat Completions fixtures and custom paths', async () => {
    let requestedUrl = '';
    const config = loadOpenAICompatibleConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_API_STYLE: 'chat_completions',
      OPENAI_CHAT_COMPLETIONS_PATH: '/compatible/chat',
    });
    const client = createOpenAICompatibleClient(config, {
      fetch: async (url) => {
        requestedUrl = String(url);
        return new Response(await fixture('chat-completions.json'), { status: 200 });
      },
    });

    expect(await client.call('summarize')).toBe('{"results":[]}');
    expect(requestedUrl).toBe('https://api.openai.com/v1/compatible/chat');
  });

  test('retries transient failures and never returns an empty successful payload', async () => {
    let attempts = 0;
    const client = createOpenAICompatibleClient(
      loadOpenAICompatibleConfig({ OPENAI_API_KEY: 'fixture-key' }),
      {
        maxAttempts: 2,
        retryDelayMs: 0,
        sleep: async () => {},
        fetch: async () => {
          attempts++;
          return attempts === 1
            ? new Response('temporary', { status: 503 })
            : new Response('{"output":[]}', { status: 200 });
        },
      },
    );

    await expect(client.call('prompt')).rejects.toThrow('did not contain output text');
    expect(attempts).toBe(2);
  });

  test('retries the relay pool-protection 400 observed in production', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createOpenAICompatibleClient(
      loadOpenAICompatibleConfig({ OPENAI_API_KEY: 'fixture-key' }),
      {
        maxAttempts: 5,
        retryDelayMs: 5_000,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
        onRetry: () => {},
        fetch: async () => {
          attempts++;
          if (attempts < 3) {
            return new Response(JSON.stringify({
              error: {
                message: '当前号池正在遭受恶意毁号请求，暂停同步请求',
                type: 'new_api_error',
                code: 'invalid_request',
              },
            }), { status: 400 });
          }
          return new Response(await fixture('responses.json'), { status: 200 });
        },
      },
    );

    expect(await client.call('score these')).toBe('{"results":[]}');
    expect(attempts).toBe(3);
    expect(delays).toEqual([5_000, 10_000]);
  });

  test('does not retry an ordinary invalid request 400', async () => {
    let attempts = 0;
    const client = createOpenAICompatibleClient(
      loadOpenAICompatibleConfig({ OPENAI_API_KEY: 'fixture-key' }),
      {
        maxAttempts: 5,
        retryDelayMs: 0,
        sleep: async () => {},
        onRetry: () => {},
        fetch: async () => {
          attempts++;
          return new Response(JSON.stringify({
            error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' },
          }), { status: 400 });
        },
      },
    );

    await expect(client.call('prompt')).rejects.toThrow('model not found');
    expect(attempts).toBe(1);
  });

  test('exhausts the default five attempts for a persistent relay pool-protection error', async () => {
    let attempts = 0;
    const client = createOpenAICompatibleClient(
      loadOpenAICompatibleConfig({ OPENAI_API_KEY: 'fixture-key' }),
      {
        retryDelayMs: 0,
        sleep: async () => {},
        onRetry: () => {},
        fetch: async () => {
          attempts++;
          return new Response(JSON.stringify({
            error: {
              message: '当前号池正在遭受恶意毁号请求，暂停同步请求',
              type: 'new_api_error',
              code: 'invalid_request',
            },
          }), { status: 400 });
        },
      },
    );

    await expect(client.call('prompt')).rejects.toThrow('暂停同步请求');
    expect(attempts).toBe(5);
  });

  test('requires an API key and rejects unknown styles', () => {
    expect(() => loadOpenAICompatibleConfig({})).toThrow(ProviderConfigError);
    expect(() =>
      loadOpenAICompatibleConfig({
        OPENAI_API_KEY: 'fixture-key',
        OPENAI_API_STYLE: 'legacy',
      }),
    ).toThrow('OPENAI_API_STYLE');
  });
});
