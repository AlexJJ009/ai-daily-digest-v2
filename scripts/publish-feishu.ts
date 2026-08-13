import { publishDailyDigest } from '../src/delivery/feishu';
import { LarkCliGateway } from '../src/delivery/lark-cli';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const args = process.argv.slice(2);
const markdownIndex = args.indexOf('--markdown');
const markdownPath = markdownIndex >= 0 ? args[markdownIndex + 1] : undefined;
if (!markdownPath) throw new Error('--markdown <path> is required');
if (!args.includes('--archive-pushed')) {
  throw new Error('--archive-pushed is required after a successful Git push');
}

const result = await publishDailyDigest({
  gateway: new LarkCliGateway(),
  now: new Date(),
  folderToken: required('FEISHU_FOLDER_TOKEN'),
  receiveId: required('FEISHU_RECEIVE_ID'),
  receiveIdType: required('FEISHU_RECEIVE_ID_TYPE'),
  markdownPath,
  archivePushed: true,
});

console.log(`Feishu ${result.action}: ${result.title}; card key=${result.idempotencyKey}`);
