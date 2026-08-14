import { describe, expect, test } from 'bun:test';

import { validateLinearWorkflowRuntime } from '../../scripts/check-linear-workflow-runtime';

const workflowPath = new URL('../../.github/workflows/linear-workflow-runtime.yml', import.meta.url);
const validWorkflow = await Bun.file(workflowPath).text();

function expectRejected(source: string, message: string): void {
  expect(() => validateLinearWorkflowRuntime(source)).toThrow(message);
}

describe('linear-workflow-runtime gate canaries', () => {
  test('accepts the repository workflow', () => {
    expect(() => validateLinearWorkflowRuntime(validWorkflow)).not.toThrow();
  });

  test('fails when the required check job is renamed', () => {
    const mutated = validWorkflow.replace(
      'jobs:\n  linear-workflow-runtime:\n    name: linear-workflow-runtime',
      'jobs:\n  renamed-gate:\n    name: renamed-gate',
    );
    expectRejected(mutated, 'job linear-workflow-runtime must be a mapping');
  });

  test('fails when pull_request is removed', () => {
    const mutated = validWorkflow.replace('  pull_request:\n', '  workflow_dispatch:\n');
    expectRejected(mutated, 'pull_request trigger must be a mapping');
  });

  test('fails when pull_request no longer covers main', () => {
    const mutated = validWorkflow.replace('branches: [main, v2]', 'branches: [v2]');
    expectRejected(mutated, 'pull_request trigger must cover main');
  });

  test('fails when pull_request no longer covers v2', () => {
    const mutated = validWorkflow.replace('branches: [main, v2]', 'branches: [main]');
    expectRejected(mutated, 'pull_request trigger must cover v2');
  });

  test('fails when a narrow path filter is introduced', () => {
    const mutated = validWorkflow.replace(
      '    branches: [main, v2]',
      '    branches: [main, v2]\n    paths: [scripts/**]',
    );
    expectRejected(mutated, 'pull_request trigger must not use path filters');
  });

  test('fails when permissions become write-capable', () => {
    const mutated = validWorkflow.replace('contents: read', 'contents: write');
    expectRejected(mutated, 'workflow permissions must declare contents: read');
  });

  test('fails when Bun is no longer pinned', () => {
    const mutated = validWorkflow.replace("bun-version: '1.3.11'", 'bun-version: latest');
    expectRejected(mutated, 'Bun must be pinned to 1.3.11');
  });

  test('fails when a key Action is not commit-pinned', () => {
    const mutated = validWorkflow.replace(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/checkout@v4',
    );
    expectRejected(mutated, 'action is not pinned to a commit SHA');
  });

  test('fails when the workflow reads a production Secret', () => {
    const secretReference = '${{ ' + 'secrets.' + 'OPENAI_API_KEY }}';
    const mutated = validWorkflow.replace(
      '    runs-on: ubuntu-latest',
      `    runs-on: ubuntu-latest\n    env:\n      OPENAI_API_KEY: ${secretReference}`,
    );
    expectRejected(mutated, 'workflow must not read GitHub Secrets');
  });
});
