import { describe, expect, test } from 'bun:test';

import {
  buildDigestFailureCard,
  digestFailureIdempotencyKey,
  failureNotificationDate,
} from '../../src/delivery/failure-notification';

const input = {
  date: '2026-08-17',
  runUrl: 'https://github.com/example/digest/actions/runs/123',
  runId: '123',
  runAttempt: '2',
};

describe('digest failure notification', () => {
  test('uses the Beijing date and a per-run-attempt idempotency key', () => {
    expect(failureNotificationDate(new Date('2026-08-16T16:30:00Z'))).toBe('2026-08-17');
    expect(digestFailureIdempotencyKey(input)).toBe('ai-digest-fail-2026-08-17-123-2');
  });

  test('builds a red failure card linked to the Actions run', () => {
    const card = JSON.parse(buildDigestFailureCard(input));
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('2026-08-17');
    expect(card.body.elements[1].behaviors).toEqual([
      { type: 'open_url', default_url: input.runUrl },
    ]);
    expect(JSON.stringify(card)).toContain('未发布');
  });
});
