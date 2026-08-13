import { describe, expect, test } from 'bun:test';

import {
  REQUIRED_PRODUCTION_SECRETS,
  REQUIRED_PRODUCTION_VARIABLES,
  shouldRunProduction,
  validateProductionEnvironment,
} from '../../src/delivery/preflight';

const valid = Object.fromEntries(
  [...REQUIRED_PRODUCTION_SECRETS, ...REQUIRED_PRODUCTION_VARIABLES].map((name) => [name, 'configured']),
);
valid.OPENAI_BASE_URL = 'https://provider.example/v1';
valid.OPENAI_API_STYLE = 'responses';
valid.FEISHU_RECEIVE_ID_TYPE = 'chat_id';
valid.PRODUCTION_ENABLED = 'false';

describe('production preflight', () => {
  test('accepts third-party OpenAI-compatible configuration', () => {
    expect(() => validateProductionEnvironment(valid)).not.toThrow();
  });

  for (const name of [...REQUIRED_PRODUCTION_SECRETS, ...REQUIRED_PRODUCTION_VARIABLES]) {
    test(`fails closed when ${name} is missing`, () => {
      expect(() => validateProductionEnvironment({ ...valid, [name]: '' })).toThrow(name);
    });
  }

  test('allows manual runs while production is disabled', () => {
    expect(shouldRunProduction('workflow_dispatch', 'false')).toBeTrue();
    expect(shouldRunProduction('schedule', 'false')).toBeFalse();
    expect(shouldRunProduction('schedule', 'true')).toBeTrue();
  });

  test('accepts open_id and rejects ambiguous user_id recipient configuration', () => {
    expect(() => validateProductionEnvironment({ ...valid, FEISHU_RECEIVE_ID_TYPE: 'open_id' })).not.toThrow();
    expect(() => validateProductionEnvironment({ ...valid, FEISHU_RECEIVE_ID_TYPE: 'user_id' }))
      .toThrow('chat_id or open_id');
  });
});
