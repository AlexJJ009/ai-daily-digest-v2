import { $ } from 'bun';

interface BatchDefinition {
  id: string;
  baseBranch: string;
  baseSha: string;
  workingBranch: string;
  includedIssues: string[];
  acceptance: string[];
  permittedPaths: string[];
}

const DEFINITIONS: Record<string, BatchDefinition> = {
  'GON-16': {
    id: 'GON-16',
    baseBranch: 'v2',
    baseSha: '1c9a41162a2d47cf317e26060441319b9722596b',
    workingBranch: 'linear/gon-16-feishu-delivery',
    includedIssues: ['GON-19', 'GON-21'],
    acceptance: [
      'Complete GON-19 then GON-21 and stop at human merge approval.',
      'Provide candidate-bound CI, High-risk gate self-tests, and fresh independent review.',
      'Leave real two-run workflow_dispatch acceptance to post-merge GON-23.',
    ],
    permittedPaths: [
      'README.md', 'bun.lock', 'package.json', 'scripts/', 'src/', 'tests/',
      'linear_workflow/reviews/', '.github/workflows/digest.yml',
      '.github/workflows/linear-workflow-runtime.yml',
    ],
  },
  'GON-23': {
    id: 'GON-23',
    baseBranch: 'v2',
    baseSha: '3fa12ba60962867cc79d4199a447c2bcf0526969',
    workingBranch: 'linear/gon-23-promote-main-accept',
    includedIssues: ['GON-17'],
    acceptance: [
      'Remove Pages deployment and production HTML conversion while preserving dated Markdown, RSS, and repository commits.',
      'Require candidate-bound pull-request validation for both main and v2.',
      'Provide full High-risk CI and fresh independent review, then stop at the implementation PR merge approval boundary.',
    ],
    permittedPaths: [
      '.github/workflows/digest.yml',
      '.github/workflows/linear-workflow-runtime.yml',
      'README.md',
      'scripts/check-linear-workflow-runtime.ts',
      'scripts/check-production-workflow.ts',
      'scripts/render-linear-workflow-batch.ts',
      'tests/workflows/digest-workflow.test.ts',
      'tests/workflows/linear-workflow-runtime.test.ts',
      'linear_workflow/reviews/',
    ],
  },
  'GON-24': {
    id: 'GON-24',
    baseBranch: 'main',
    baseSha: 'b3bfeeafe4834d390e90a9929de8099625fd20b9',
    workingBranch: 'linear/gon-24-feishu-title-idempotency',
    includedIssues: ['GON-25'],
    acceptance: [
      'Restore the canonical daily Docx title after every Markdown create or overwrite.',
      'Re-enumerate the configured folder and require exactly one canonical title whose token matches the written document.',
      'Send the interactive card only after post-write title and token verification succeeds.',
      'Provide full High-risk CI and fresh independent review, then stop at the implementation PR merge approval boundary.',
    ],
    permittedPaths: [
      '.github/workflows/linear-workflow-runtime.yml',
      'linear_workflow/reviews/',
      'scripts/render-linear-workflow-batch.ts',
      'src/delivery/feishu.ts',
      'src/delivery/lark-cli.ts',
      'tests/delivery/feishu.test.ts',
      'tests/workflows/linear-workflow-runtime.test.ts',
    ],
  },
  'GON-26': {
    id: 'GON-26',
    baseBranch: 'main',
    baseSha: '44056a68343b22fa8099f6fabdaa66f117ca148a',
    workingBranch: 'linear/gon-26-feishu-card-day-idempotency',
    includedIssues: ['GON-27'],
    acceptance: [
      'Preserve canonical-title restoration and post-write unique-token verification.',
      'Send the daily card only after creating a new canonical daily Docx.',
      'Keep every same-day Docx update card-silent, including reruns beyond one hour.',
      'Document and test the at-most-once manual-recovery boundary after initial card failure.',
      'Provide full High-risk CI and fresh independent review, then stop at the implementation PR merge approval boundary.',
    ],
    permittedPaths: [
      '.github/workflows/linear-workflow-runtime.yml',
      'README.md',
      'linear_workflow/reviews/',
      'scripts/render-linear-workflow-batch.ts',
      'src/delivery/feishu.ts',
      'tests/delivery/feishu.test.ts',
      'tests/workflows/linear-workflow-runtime.test.ts',
    ],
  },
};

const batchId = process.env.LINEAR_BATCH_ID ?? 'GON-23';
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
    base_branch: definition.baseBranch,
    base_sha: definition.baseSha,
    working_branch: definition.workingBranch,
    candidate_sha: candidate,
    github_pull_request: null,
  }],
  permitted_paths: definition.permittedPaths,
  changed_paths: changedPaths,
  integration_evidence: null,
}));
