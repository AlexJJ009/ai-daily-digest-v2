type JsonObject = Record<string, unknown>;

const WORKFLOW_PATH = '.github/workflows/digest.yml';
const PINNED_BUN = '1.3.11';

function objectAt(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as JsonObject;
}

function arrayAt(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function validateProductionWorkflow(source: string): void {
  if (source.includes('api.openai.com')) throw new Error('workflow must not hardcode the official OpenAI host');
  if (/GEMINI|GOOGLE_VERTEX/.test(source)) throw new Error('workflow must not require Gemini');
  const workflow = objectAt(Bun.YAML.parse(source), 'workflow');
  const triggers = objectAt(workflow.on, 'workflow triggers');
  const schedules = arrayAt(triggers.schedule, 'schedule trigger').map((entry) => objectAt(entry, 'schedule entry'));
  if (!schedules.some((entry) => entry.cron === '0 0 * * *')) throw new Error('schedule must run at UTC 00:00');
  objectAt(triggers.workflow_dispatch, 'workflow_dispatch trigger');

  const jobs = objectAt(workflow.jobs, 'jobs');
  const preflight = objectAt(jobs.preflight, 'preflight job');
  const gate = String(preflight.if ?? '');
  if (!gate.includes("github.event_name == 'workflow_dispatch'") ||
      !gate.includes("github.event_name == 'schedule'") ||
      !gate.includes("vars.PRODUCTION_ENABLED == 'true'")) {
    throw new Error('production gate must allow manual runs and gate scheduled runs');
  }
  const digest = objectAt(jobs.digest, 'digest job');
  const concurrency = objectAt(digest.concurrency, 'digest concurrency');
  if (!String(concurrency.group).includes('needs.preflight.outputs.beijing_date')) {
    throw new Error('concurrency must use the Beijing publication date');
  }

  const allSteps = Object.values(jobs).flatMap((jobValue) =>
    arrayAt(objectAt(jobValue, 'job').steps, 'job steps').map((step) => objectAt(step, 'step')),
  );
  const actions = allSteps.map((step) => step.uses).filter((value): value is string => typeof value === 'string');
  for (const action of actions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(action)) {
      throw new Error(`action is not pinned to a commit SHA: ${action}`);
    }
  }
  const setupSteps = allSteps.filter((step) => String(step.uses ?? '').startsWith('oven-sh/setup-bun@'));
  if (setupSteps.length === 0 || setupSteps.some((step) => objectAt(step.with, 'setup-bun inputs')['bun-version'] !== PINNED_BUN)) {
    throw new Error(`Bun must be pinned to ${PINNED_BUN}`);
  }

  const digestSteps = arrayAt(digest.steps, 'digest steps').map((step) => objectAt(step, 'digest step'));
  const requiredOrder = [
    'bun scripts/digest.ts',
    'convert-md-to-html.sh',
    'git push origin',
    'bun scripts/publish-feishu.ts',
  ];
  let previous = -1;
  for (const command of requiredOrder) {
    const index = source.indexOf(command);
    if (index <= previous) throw new Error(`production command is missing or out of order: ${command}`);
    previous = index;
  }
  if (!source.includes('@larksuite/cli') && !source.includes('./node_modules/.bin/lark-cli')) {
    throw new Error('workflow must use the pinned lark-cli dependency');
  }
  const preflightIndex = source.indexOf('bun scripts/preflight-production.ts');
  const modelIndex = source.indexOf('bun scripts/digest.ts');
  if (preflightIndex < 0 || modelIndex < 0 || preflightIndex > modelIndex) {
    throw new Error('configuration preflight must precede source and model work');
  }
}

if (import.meta.main) {
  validateProductionWorkflow(await Bun.file(WORKFLOW_PATH).text());
  console.log(`production workflow contract ok: ${WORKFLOW_PATH}`);
}
