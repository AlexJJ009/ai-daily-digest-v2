type JsonObject = Record<string, unknown>;

const WORKFLOW_PATH = '.github/workflows/linear-workflow-runtime.yml';
const REQUIRED_CHECK = 'linear-workflow-runtime';
const REQUIRED_BUN_VERSION = '1.3.11';
const REQUIRED_ACTIONS = ['actions/checkout', 'oven-sh/setup-bun'] as const;
const REQUIRED_COMMANDS = [
  'bun install --frozen-lockfile',
  'bun run typecheck',
  'bun test',
  'bun run check:fork',
  'bun run check:production',
  'git diff --check',
  'bun run check:secrets',
  'bun run check:gate',
  'python3 -m linear_workflow_runtime.cli batch-check',
] as const;

function objectAt(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as JsonObject;
}

function arrayAt(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertReadOnlyPermissions(workflow: JsonObject, jobs: JsonObject): void {
  const permissions = objectAt(workflow.permissions, 'workflow permissions');
  if (permissions.contents !== 'read') {
    throw new Error('workflow permissions must declare contents: read');
  }

  const permissionSets = [permissions];
  for (const [jobName, jobValue] of Object.entries(jobs)) {
    const job = objectAt(jobValue, `job ${jobName}`);
    if (job.permissions !== undefined) {
      permissionSets.push(objectAt(job.permissions, `job ${jobName} permissions`));
    }
  }

  for (const permissionSet of permissionSets) {
    for (const value of Object.values(permissionSet)) {
      if (value === 'write') {
        throw new Error('workflow and job permissions must remain read-only');
      }
    }
  }
}

export function validateLinearWorkflowRuntime(source: string): void {
  if (/\bsecrets\s*\./i.test(source)) {
    throw new Error('workflow must not read GitHub Secrets');
  }
  if (/\b(?:OPENAI|GEMINI|FEISHU|LARK)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\b/i.test(source)) {
    throw new Error('workflow must not reference production credential names');
  }

  const workflow = objectAt(Bun.YAML.parse(source), 'workflow');
  if (workflow.name !== REQUIRED_CHECK) {
    throw new Error(`workflow name must be ${REQUIRED_CHECK}`);
  }

  const triggers = objectAt(workflow.on, 'workflow triggers');
  const pullRequest = objectAt(triggers.pull_request, 'pull_request trigger');
  const branches = arrayAt(pullRequest.branches, 'pull_request branches');
  if (!branches.includes('v2')) {
    throw new Error('pull_request trigger must cover v2');
  }
  if ('paths' in pullRequest || 'paths-ignore' in pullRequest) {
    throw new Error('pull_request trigger must not use path filters');
  }

  const jobs = objectAt(workflow.jobs, 'jobs');
  const gateJob = objectAt(jobs[REQUIRED_CHECK], `job ${REQUIRED_CHECK}`);
  if (gateJob.name !== REQUIRED_CHECK) {
    throw new Error(`job name must be ${REQUIRED_CHECK}`);
  }
  assertReadOnlyPermissions(workflow, jobs);

  const steps = arrayAt(gateJob.steps, 'gate job steps').map((value, index) =>
    objectAt(value, `gate job step ${index}`),
  );
  const actionRefs = steps
    .map((step) => step.uses)
    .filter((value): value is string => typeof value === 'string');
  for (const actionRef of actionRefs) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(actionRef)) {
      throw new Error(`action is not pinned to a commit SHA: ${actionRef}`);
    }
  }
  for (const action of REQUIRED_ACTIONS) {
    if (!actionRefs.some((value) => value.startsWith(`${action}@`))) {
      throw new Error(`required pinned action is missing: ${action}`);
    }
  }

  const setupBun = steps.find((step) =>
    typeof step.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@'),
  );
  const setupBunWith = objectAt(setupBun?.with, 'setup-bun inputs');
  if (setupBunWith['bun-version'] !== REQUIRED_BUN_VERSION) {
    throw new Error(`Bun must be pinned to ${REQUIRED_BUN_VERSION}`);
  }

  const commands = steps
    .map((step) => step.run)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  for (const command of REQUIRED_COMMANDS) {
    if (!commands.includes(command)) {
      throw new Error(`required validation command is missing: ${command}`);
    }
  }
}

if (import.meta.main) {
  const source = await Bun.file(WORKFLOW_PATH).text();
  validateLinearWorkflowRuntime(source);
  console.log(`workflow gate contract ok: ${WORKFLOW_PATH}`);
}
