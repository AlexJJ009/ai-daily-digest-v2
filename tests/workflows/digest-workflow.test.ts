import { describe, expect, test } from 'bun:test';

import { validateProductionWorkflow } from '../../scripts/check-production-workflow';

const path = new URL('../../.github/workflows/digest.yml', import.meta.url);
const valid = await Bun.file(path).text();

describe('production workflow canaries', () => {
  test('accepts the production workflow', () => {
    expect(() => validateProductionWorkflow(valid)).not.toThrow();
  });

  test('rejects Pages deployment or production HTML conversion', () => {
    expect(() => validateProductionWorkflow(valid.replace(
      'jobs:\n',
      'jobs:\n  deploy-pages:\n    runs-on: ubuntu-latest\n    steps: []\n',
    ))).toThrow('deploy-pages');
    expect(() => validateProductionWorkflow(valid.replace(
      '          echo "markdown_path=',
      '          bash scripts/convert-md-to-html.sh digest.md > docs/index.html\n          echo "markdown_path=',
    ))).toThrow('HTML conversion');
  });

  test('rejects removal of the dated Markdown archive commit', () => {
    expect(() => validateProductionWorkflow(valid.replace(
      '--output "./docs/digest-${DATE_COMPACT}.md"',
      '--output "./digest.md"',
    ))).toThrow('dated Markdown archive');
    expect(() => validateProductionWorkflow(valid.replace('git add docs/', 'git add digest.md')))
      .toThrow('Markdown/RSS archive');
  });

  test('rejects GitHub Release creation', () => {
    expect(() => validateProductionWorkflow(`${valid}\n# gh release create daily`))
      .toThrow('GitHub Releases');
  });

  test('rejects a changed cron', () => {
    expect(() => validateProductionWorkflow(valid.replace("cron: '0 0 * * *'", "cron: '0 6 * * *'")))
      .toThrow('UTC 00:00');
  });

  test('rejects removal of manual dispatch', () => {
    expect(() => validateProductionWorkflow(valid.replace('  workflow_dispatch:\n', '  push:\n')))
      .toThrow('workflow_dispatch');
  });

  test('rejects bypassing the production schedule gate', () => {
    const mutated = valid.replace(
      "github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && vars.PRODUCTION_ENABLED == 'true')",
      "github.event_name == 'schedule'",
    );
    expect(() => validateProductionWorkflow(mutated)).toThrow('production gate');
  });

  test('rejects an unpinned Action or Bun', () => {
    expect(() => validateProductionWorkflow(valid.replace(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@v4',
    ))).toThrow('not pinned');
    expect(() => validateProductionWorkflow(valid.replace("bun-version: '1.3.11'", 'bun-version: latest')))
      .toThrow('Bun must be pinned');
  });

  test('rejects provider lock-in or Gemini', () => {
    expect(() => validateProductionWorkflow(`${valid}\n# api.openai.com`)).toThrow('official OpenAI host');
    expect(() => validateProductionWorkflow(`${valid}\n# GEMINI_API_KEY`)).toThrow('Gemini');
  });

  test('rejects card publication before Git push', () => {
    const mutated = valid
      .replace('run: bun scripts/publish-feishu.ts --markdown "$markdown_path" --archive-pushed', 'run: echo delayed-card')
      .replace('bun scripts/digest.ts \\', 'bun scripts/publish-feishu.ts --markdown premature.md --archive-pushed\n          bun scripts/digest.ts \\');
    expect(() => validateProductionWorkflow(mutated)).toThrow('out of order');
  });
});
