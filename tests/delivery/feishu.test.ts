import { describe, expect, test } from 'bun:test';

import {
  buildDigestCard,
  dailyCardIdempotencyKey,
  dailyDigestTitle,
  findExactDailyDocument,
  publishDailyDigest,
  type FeishuDocument,
  type FeishuGateway,
  type FolderFile,
} from '../../src/delivery/feishu';
import { LarkCliGateway, parseFolderFiles, type CommandResult } from '../../src/delivery/lark-cli';

const now = new Date('2026-08-12T16:30:00.000Z');
const fixture = (name: string) => Bun.file(new URL(`../fixtures/feishu/${name}.json`, import.meta.url)).text();

class FakeGateway implements FeishuGateway {
  events: string[] = [];
  failAt?: 'create' | 'update' | 'card';
  constructor(readonly files: FolderFile[]) {}
  async listFolder(): Promise<FolderFile[]> { this.events.push('list'); return this.files; }
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
    const gateway = new FakeGateway(parseFolderFiles(await fixture('folder-zero')));
    expect((await publishDailyDigest(input(gateway))).action).toBe('created');
    expect(gateway.events).toEqual(['list', 'create', 'card:ai-digest-2026-08-13']);
  });

  test('one exact match updates the Docx then sends the card', async () => {
    const gateway = new FakeGateway(parseFolderFiles(await fixture('folder-one')));
    expect((await publishDailyDigest(input(gateway))).action).toBe('updated');
    expect(gateway.events).toEqual(['list', 'update', 'card:ai-digest-2026-08-13']);
  });

  test('multiple exact matches fail closed before a write', async () => {
    const files = parseFolderFiles(await fixture('folder-multiple'));
    expect(() => findExactDailyDocument(files, dailyDigestTitle(now))).toThrow('multiple Docx');
    const gateway = new FakeGateway(files);
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('multiple Docx');
    expect(gateway.events).toEqual(['list']);
  });

  test('a failed archive push prevents Docx and card operations', async () => {
    const gateway = new FakeGateway([]);
    await expect(publishDailyDigest(input(gateway, false))).rejects.toThrow('Git archive push');
    expect(gateway.events).toEqual([]);
  });

  test('a document failure prevents the card', async () => {
    const gateway = new FakeGateway([]);
    gateway.failAt = 'create';
    await expect(publishDailyDigest(input(gateway))).rejects.toThrow('create failed');
    expect(gateway.events).toEqual(['list', 'create']);
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
      { exitCode: 0, stdout: JSON.stringify({ message_id: 'message' }), stderr: '' },
    ];
    const gateway = new LarkCliGateway(async (args) => {
      calls.push(args);
      return responses.shift()!;
    });
    await publishDailyDigest(input(gateway));
    expect(calls[0]?.slice(0, 7)).toEqual([
      'drive', 'files', 'list', '--folder-token', 'folder', '--page-all', '--page-limit',
    ]);
    expect(calls[0]).not.toContain('search');
    expect(calls[1]).toContain('+create');
    expect(calls[2]).toContain('interactive');
    for (const call of calls) {
      expect(call).toContain('--as');
      expect(call).toContain('bot');
      expect(call).toContain('production');
    }
  });

  test('uses overwrite for the single matching Docx', async () => {
    const calls: string[][] = [];
    const gateway = new LarkCliGateway(async (args) => {
      calls.push(args);
      if (args.includes('list')) return { exitCode: 0, stdout: await fixture('folder-one'), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    });
    await publishDailyDigest(input(gateway));
    expect(calls[1]).toContain('+update');
    expect(calls[1]).toContain('overwrite');
    expect(calls[1]).toContain('doc-one');
  });
});
