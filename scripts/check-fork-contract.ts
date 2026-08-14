import { $ } from 'bun';

const FROZEN_BASE = process.env.FROZEN_BASE_SHA ?? '1c9a41162a2d47cf317e26060441319b9722596b';
const EXPECTED_ORIGIN = 'https://github.com/AlexJJ009/ai-daily-digest-v2.git';
const EXPECTED_UPSTREAM = 'https://github.com/AllenX-Li/ai-daily-digest.git';

async function git(...args: string[]): Promise<string> {
  return (await $`git ${args}`.text()).trim();
}

function requireEqual(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

requireEqual('origin URL', await git('remote', 'get-url', 'origin'), EXPECTED_ORIGIN);
requireEqual('upstream URL', await git('remote', 'get-url', 'upstream'), EXPECTED_UPSTREAM);
requireEqual('origin/v2 frozen base', await git('rev-parse', 'origin/v2'), FROZEN_BASE);

await $`git merge-base --is-ancestor ${FROZEN_BASE} HEAD`.quiet();

console.log(`fork contract ok: origin/v2=${FROZEN_BASE}, HEAD descends from frozen base`);
