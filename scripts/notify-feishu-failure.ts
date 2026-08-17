import { LarkCliGateway } from '../src/delivery/lark-cli';
import {
  buildDigestFailureCard,
  digestFailureIdempotencyKey,
  failureNotificationDate,
} from '../src/delivery/failure-notification';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const input = {
  date: process.env.BEIJING_DATE?.trim() || failureNotificationDate(),
  runUrl: required('GITHUB_RUN_URL'),
  runId: required('GITHUB_RUN_ID'),
  runAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() || '1',
};

await new LarkCliGateway().sendCard(
  required('FEISHU_RECEIVE_ID'),
  required('FEISHU_RECEIVE_ID_TYPE'),
  buildDigestFailureCard(input),
  digestFailureIdempotencyKey(input),
);

console.log(`Feishu failure notification sent for ${input.date}; run=${input.runId}.${input.runAttempt}`);
