import { $ } from 'bun';

const BASE_SHA = '9f9f5cecdd76cb33087400ffd8004489801b6250';
const candidate = process.env.CANDIDATE_SHA;

if (!candidate || !/^[0-9a-f]{40}$/.test(candidate)) {
  throw new Error('CANDIDATE_SHA must be a 40-character lowercase commit SHA');
}

const changedPaths = (await $`git diff --name-only ${BASE_SHA}..${candidate}`.text())
  .trim()
  .split('\n')
  .filter(Boolean);

// batch-check validates the human-approved admission contract and candidate path scope.
// The live In Progress lifecycle state remains authoritative in Linear.
const batch = {
  schema_version: 1,
  workflow_version: '0.4.0',
  id: 'GON-15',
  status: 'Ready',
  risk_profile: 'high',
  included_issues: ['GON-14', 'GON-20', 'GON-18', 'GON-22'],
  acceptance: [
    'Complete GON-14, GON-20, GON-18, and GON-22 in the approved DAG and stop at human merge approval.',
    'Provide a real candidate-bound linear-workflow-runtime check and fresh independent R3 review.',
  ],
  full_ci_point: 'After the GON-22 code candidate is frozen and before independent R3 review.',
  work_references: [
    {
      repository_full_name: 'AlexJJ009/ai-daily-digest-v2',
      base_branch: 'v2',
      base_sha: BASE_SHA,
      working_branch: 'linear/gon-15-digest-core-v2',
      candidate_sha: candidate,
      github_pull_request: 'AlexJJ009/ai-daily-digest-v2#7',
    },
  ],
  permitted_paths: [
    'LICENSE',
    'NOTICE',
    'README.md',
    'bun.lock',
    'config/',
    'package.json',
    'scripts/',
    'src/',
    'tests/',
    'tsconfig.json',
    'linear_workflow/reviews/',
    '.github/workflows/linear-workflow-runtime.yml',
  ],
  changed_paths: changedPaths,
  integration_evidence: null,
};

console.log(JSON.stringify(batch));
