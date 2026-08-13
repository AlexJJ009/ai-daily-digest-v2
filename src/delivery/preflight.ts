export const REQUIRED_PRODUCTION_SECRETS = [
  'OPENAI_API_KEY',
  'FEISHU_APP_SECRET',
  'FEISHU_FOLDER_TOKEN',
] as const;

export const REQUIRED_PRODUCTION_VARIABLES = [
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_STYLE',
  'OPENAI_RESPONSES_PATH',
  'OPENAI_CHAT_COMPLETIONS_PATH',
  'FEISHU_APP_ID',
  'FEISHU_RECEIVE_ID',
  'FEISHU_RECEIVE_ID_TYPE',
  'PRODUCTION_ENABLED',
] as const;

export function validateProductionEnvironment(env: Record<string, string | undefined>): void {
  const missing = [...REQUIRED_PRODUCTION_SECRETS, ...REQUIRED_PRODUCTION_VARIABLES]
    .filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing required production configuration: ${missing.join(', ')}`);
  }
  if (!['responses', 'chat_completions'].includes(env.OPENAI_API_STYLE!)) {
    throw new Error('OPENAI_API_STYLE must be responses or chat_completions');
  }
  if (!['chat_id', 'open_id'].includes(env.FEISHU_RECEIVE_ID_TYPE!)) {
    throw new Error('FEISHU_RECEIVE_ID_TYPE must be chat_id or open_id');
  }
  if (!['true', 'false'].includes(env.PRODUCTION_ENABLED!)) {
    throw new Error('PRODUCTION_ENABLED must be true or false');
  }
  const baseUrl = new URL(env.OPENAI_BASE_URL!);
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new Error('OPENAI_BASE_URL must be an HTTP(S) URL');
  }
}

export function shouldRunProduction(eventName: string, productionEnabled: string | undefined): boolean {
  return eventName === 'workflow_dispatch' || (
    eventName === 'schedule' && productionEnabled === 'true'
  );
}
