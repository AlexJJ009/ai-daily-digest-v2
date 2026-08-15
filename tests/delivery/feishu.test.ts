import { describe, expect, test } from 'bun:test';

import {
  buildDigestCard,
  dailyCardIdempotencyKey,
  dailyDigestTitle,
  findExactDailyDocument,
  publishDailyDigest,
  verifyWrittenDailyDocument,
  type FeishuDocument,
  type FeishuGateway,
  type FolderFile,
} from '../../src/delivery/feishu';
import { LarkCliGateway, parseFolderFiles, type CommandResult } from '../../src/delivery/lark-cli';

const now = new Date('2026-08-12T16:30:00.000Z');
const fixture = (name: string) => Bun.file(new URL(`../fixtures/feishu/${name}.json`, import.meta.url)).text();

class FakeGateway implements FeishuGateway {
  events: string[] = [];
  failAt?: 'create' | 'update' | 'restore' | 'card';
  private listIndex = 0;
  constructor(readonly listings: FolderFile[][]) {}
  async listFolder(): Promise<FolderFile[]> {
    this.events.push('list');
    return this.listings[Math.min(this.listIndex++, this.listings.length - 1)] ?? [];
  }
  async createDocument(): Promise<FeishuDocument> {
    this.events.push('create');
    if (this.failAt === 'create') throw new Error('create failed');
    return { token: 'created', url: 'https://example.test/docx/created' };
  }
  async updateDocument(document: FolderFile): Promise<FeishuDocument> {
    this.events.push('update');
    if (this.failAt === 'update') throw new Error('update failed');
    return { token: document.token, url: document.url! };
  }
  async restoreDocumentTitle(): Promise<void> {
    this.events.push('restore');
    if (this.failAt === 'restore') throw new Error('restore failed');
  }
  async sendCard(_id: string, _type: string, _card: string, key: string): Promise<void> {
    this.events.push(`card:${key}`);
    if (this.failAt === 'card') throw new Error('card failed');
  }
}

function input(gateway: FeishuGateway, archivePushed = true) {
  return {
    gateway, now, folderToken: 'folder', receiveId: 'chat', receiveIdType: 'chat_id',
    markdownPath: 'docs/digest.md', archivePushed,
  };
}

describe('Feishu daily publication contract', () => {
  test('uses the Asia/Shanghai calendar day and a stable short card key', () => {
    expect(dailyDigestTitle(now)).toBe('AI Daily Digest · 2026-08-13');
    expect(dailyCardIdempotencyKey(now)).toBe('ai-digest-2026-08-13');
    expect(dailyCardIdempotencyKey(now).length).toBeLessThanOrEqual(50);
  });

  test('zero exact matches creates the Docx then sends the card', async () => {
    const gateway = new FakeGateway([
      parseFolderFiles(await fixture('folder-zero')),
      [{ token: 'created', name: dailyDigestTitle(now), type: 'docx', url: 'https://example.test/docx/created' }],
    ]);
    expect((await publishDailyDigest(input(gateway))).action).toBe('created');
    expect(gateway.events).toEqual(['list', 'create', 'restore', 'list', 'card:ai-digest-2026-08-13']);
  });

  test('one exact match restores the drifted title, verifies the token, then sends the card', async () => {
    const files = parseFolderFiles(await fixture('folder-one'));
    const gateway = new FakeGateway([files, files]);
    expect((await publishDailyDigest(input(gateway))).action).toBe('updated');
    expect(gateway.events).toEqual(['list', 'update', 'restore', 'list', 'card:ai-digest-2026-08-13']);
  });

  test('multiple exact matches fail closed before a write', async () => {
    const files = parseFolderFiles(await fixture('folder-multiple'));
    expect(() => findExactDailyDocument(files, dailyDigestTitle(now))).toThrow('multiple Docx');
    const gateway = new FakeGateway([files]);
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('multiple Docx');
    expect(gateway.events).toEqual(['list']);
  });

  test('a failed archive push prevents Docx and card operations', async () => {
    const gateway = new FakeGateway([[]]);
    await expect(publishDailyDigest(input(gateway, false))).rejects.toThrow('Git archive push');
    expect(gateway.events).toEqual([]);
  });

  test('a document failure prevents the card', async () => {
    const gateway = new FakeGateway([[]]);
    gateway.failAt = 'create';
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('create failed');
    expect(gateway.events).toEqual(['list', 'create']);
  });

  test('a title restore failure prevents verification and the card', async () => {
    const gateway = new FakeGateway([[], []]);
    gateway.failAt = 'restore';
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('restore failed');
    expect(gateway.events).toEqual(['list', 'create', 'restore']);
  });

  test('post-write zero canonical matches fail closed before the card', async () => {
    const gateway = new FakeGateway([[], []]);
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('expected exactly one Docx');
    expect(gateway.events).toEqual(['list', 'create', 'restore', 'list']);
  });

  test('post-write multiple canonical matches fail closed before the card', async () => {
    const matches = parseFolderFiles(await fixture('folder-multiple'));
    const gateway = new FakeGateway([[], matches]);
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('found 2');
    expect(gateway.events).toEqual(['list', 'create', 'restore', 'list']);
  });

  test('post-write token mismatch fails closed before the card', async () => {
    const gateway = new FakeGateway([[], [
      { token: 'different', name: dailyDigestTitle(now), type: 'docx' },
    ]]);
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('token mismatch');
    expect(gateway.events).toEqual(['list', 'create', 'restore', 'list']);
  });

  test('post-write verification requires one canonical Docx with the written token', () => {
    const title = dailyDigestTitle(now);
    expect(verifyWrittenDailyDocument([{ token: 'written', name: title, type: 'docx' }], title, 'written').token)
      .toBe('written');
    expect(() => verifyWrittenDailyDocument([], title, 'written')).toThrow('found 0');
  });

  test('builds a Card 2.0 with a single open-url action', () => {
    const card = JSON.parse(buildDigestCard(dailyDigestTitle(now), 'https://example.test/docx/created'));
    expect(card.schema).toBe('2.0');
    expect(card.config.width_mode).toBe('default');
    expect(card.header.template).toBe('green');
    expect(card.body.elements[1].behaviors).toEqual([
      { type: 'open_url', default_url: 'https://example.test/docx/created' },
    ]);
  });

  test('uses only folder enumeration and bot-scoped pinned CLI commands', async () => {
    const calls: string[][] = [];
    const responses: CommandResult[] = [
      { exitCode: 0, stdout: await fixture('folder-zero'), stderr: '' },
      {
        exitCode: 0,
        stdout: JSON.stringify({ data: { document: { document_id: 'created', url: 'https://example.test/docx/created' } } }),
        stderr: '',
      },
      { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' },
      {
        exitCode: 0,
        stdout: JSON.stringify({ data: { files: [{ token: 'created', name: dailyDigestTitle(now), type: 'docx' }] } }),
        stderr: '',
      },
      { exitCode: 0, stdout: JSON.stringify({ message_id: 'message' }), stderr: '' },
    ];
    const gateway = new LarkCliGateway(async (args) => {
      calls.push(args);
      return responses.shift()!;
    });
    await publishDailyDigest(input(gateway));
    expect(calls[0]?.slice(0, 6)).toEqual([
      'drive', 'files', 'list', '--folder-token', 'folder', '--page-all',
    ]);
    expect(calls[0]).not.toContain('--page-limit');
    expect(calls[0]).not.toContain('search');
    expect(calls[1]).toContain('+create');
    expect(calls[2]).toContain('+update-title');
    expect(calls[2]).toContain('--url');
    expect(calls[2]).toContain('https://example.test/docx/created');
    expect(calls[2]).toContain(dailyDigestTitle(now));
    expect(calls[3]?.slice(0, 3)).toEqual(['drive', 'files', 'list']);
    expect(calls[4]).toContain('interactive');
    for (const call of calls) {
      expect(call).toContain('--as');
      expect(call).toContain('bot');
      expect(call).toContain('production');
    }
  });

  test('uses overwrite for the single matching Docx', async () => {
    const calls: string[][] = [];
    let listCount = 0;
    const gateway = new LarkCliGateway(async (args) => {
      calls.push(args);
      if (args.includes('list')) {
        listCount += 1;
        return { exitCode: 0, stdout: await fixture('folder-one'), stderr: '' };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    });
    await publishDailyDigest(input(gateway));
    expect(calls[1]).toContain('+update');
    expect(calls[1]).toContain('overwrite');
    expect(calls[1]).toContain('doc-one');
    expect(calls[2]).toContain('+update-title');
    expect(listCount).toBe(2);
    expect(calls[4]).toContain('interactive');
  });

  test('maps open_id explicitly to the lark-cli user-id flag and rejects unknown types', async () => {
    const calls: string[][] = [];
    const gateway = new LarkCliGateway(async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify({ message_id: 'message' }), stderr: '' };
    });
    await gateway.sendCard('ou_example', 'open_id', '{}', 'key');
    expect(calls[0]).toContain('--user-id');
    expect(calls[0]).toContain('ou_example');
    await expect(gateway.sendCard('value', 'user_id', '{}', 'key')).rejects.toThrow(
      'must be chat_id or open_id',
    );
    expect(calls).toHaveLength(1);
  });
});
