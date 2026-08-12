const candidate = process.env.CANDIDATE_SHA ?? 'HEAD';
const secretPattern = [
  '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}',
  '(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}',
  '(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}',
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  '(OPENAI|GEMINI|FEISHU|LARK)_[A-Z0-9_]*(API_KEY|SECRET|TOKEN)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_./+=-]{12,}',
].join('|');

const commitCheck = Bun.spawnSync(['git', 'cat-file', '-e', `${candidate}^{commit}`]);
if (commitCheck.exitCode !== 0) {
  throw new Error(`candidate is not a commit: ${candidate}`);
}

const scan = Bun.spawnSync([
  'git',
  'grep',
  '-I',
  '-n',
  '-E',
  secretPattern,
  candidate,
  '--',
  '.',
]);
if (scan.exitCode === 0) {
  const matches = scan.stdout
    .toString()
    .trim()
    .split('\n')
    .filter((line) => !/\breplace[-_]?locally\b/i.test(line));
  if (matches.length > 0) {
    throw new Error(`candidate tree contains credential-like content:\n${matches.join('\n')}`);
  }
  console.log(`candidate secret scan ok: ${candidate} (documented placeholders ignored)`);
  process.exit(0);
}
if (scan.exitCode !== 1) {
  throw new Error(`candidate secret scan failed: ${scan.stderr.toString().trim()}`);
}

console.log(`candidate secret scan ok: ${candidate}`);
