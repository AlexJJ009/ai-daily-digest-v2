import { $ } from 'bun';

interface BatchDefinition {
  id: string;
  baseSha: string;
  workingBranch: string;
  includedIssues: string[];
  acceptance: string[];
}

const DEFINITIONS: Record<string, BatchDefinition> = {
  'GON-16': {
    id: 'GON-16',
    baseSha: '1c9a41162a2d47cf317e26060441319b9722596b',
    workingBranch: 'linear/gon-16-feishu-delivery',
    includedIssues: ['GON-19', 'GON-21'],
    acceptance: [
      'Complete GON-19 then GON-21 and stop at human merge approval.',
      'Provide candidate-bound CI, High-risk gate self-tests, and fresh independent review.',
      'Leave real two-run workflow_dispatch acceptance to post-merge GON-23.',
    ],
  },
};

const batchId = process.env.LINEAR_BATCH_ID ?? 'GON-16';
const definition = DEFINITIONS[batchId];
if (!definition) throw new Error(`unsupported LINEAR_BATCH_ID: ${batchId}`);
const candidate = process.env.CANDIDATE_SHA;
if (!candidate || !/^[0-9a-f]{40}$/.test(candidate)) {
  throw new Error('CANDIDATE_SHA must be a 40-character lowercase commit SHA');
}

const changedPaths = (await $`git diff --name-only ${definition.baseSha}..${candidate}`.text())
  .trim().split('\n').filter(Boolean);

console.log(JSON.stringify({
  schema_version: 1,
  workflow_version: '0.4.0',
  id: definition.id,
  status: 'Ready',
  risk_profile: 'high',
  included_issues: definition.includedIssues,
  acceptance: definition.acceptance,
  full_ci_point: 'After the exact code candidate is frozen and before independent review.',
  work_references: [{
    repository_full_name: 'AlexJJ009/ai-daily-digest-v2',
    base_branch: 'v2',
    base_sha: definition.baseSha,
    working_branch: definition.workingBranch,
    candidate_sha: candidate,
  }],
  permitted_paths: [
    'README.md', 'bun.lock', 'package.json', 'scripts/', 'src/', 'tests/',
    'linear_workflow/reviews/', '.github/workflows/digest.yml',
    '.github/workflows/linear-workflow-runtime.yml',
  ],
  changed_paths: changedPaths,
  integration_evidence: null,
}));
