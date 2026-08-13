import type { FeishuDocument, FeishuGateway, FolderFile } from './feishu';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(value: unknown, keys: string[]): string | undefined {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    const object = objectValue(current);
    if (object) {
      for (const key of keys) {
        if (typeof object[key] === 'string' && object[key]) return object[key] as string;
      }
      queue.push(...Object.values(object));
    } else if (Array.isArray(current)) {
      queue.push(...current);
    }
  }
  return undefined;
}

function collectFileArrays(value: unknown): unknown[][] {
  const found: unknown[][] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      if (current.some((item) => objectValue(item)?.token || objectValue(item)?.file_token)) found.push(current);
      else current.forEach(visit);
      return;
    }
    const object = objectValue(current);
    if (object) Object.values(object).forEach(visit);
  };
  visit(value);
  return found;
}

export function parseFolderFiles(stdout: string): FolderFile[] {
  const payload = JSON.parse(stdout) as unknown;
  return collectFileArrays(payload).flatMap((items) => items.flatMap((item) => {
    const object = objectValue(item);
    if (!object) return [];
    const token = typeof object.token === 'string' ? object.token : object.file_token;
    const name = typeof object.name === 'string' ? object.name : object.title;
    const type = object.type;
    if (typeof token !== 'string' || typeof name !== 'string' || typeof type !== 'string') return [];
    return [{ token, name, type, url: typeof object.url === 'string' ? object.url : undefined }];
  }));
}

export function parseDocument(stdout: string, fallbackToken?: string, fallbackUrl?: string): FeishuDocument {
  const payload = JSON.parse(stdout) as unknown;
  const token = firstString(payload, ['document_id', 'document_token', 'token']) ?? fallbackToken;
  const url = firstString(payload, ['url', 'document_url']) ?? fallbackUrl;
  if (!token || !url) throw new Error('lark-cli response did not include a document token and URL');
  return { token, url };
}

export function createBunCommandRunner(binary = './node_modules/.bin/lark-cli'): CommandRunner {
  return async (args) => {
    const process = Bun.spawn([binary, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
}

export class LarkCliGateway implements FeishuGateway {
  constructor(private readonly run: CommandRunner = createBunCommandRunner()) {}

  private async execute(args: string[]): Promise<string> {
    const result = await this.run([...args, '--as', 'bot', '--profile', 'production', '--format', 'json']);
    if (result.exitCode !== 0) {
      throw new Error(`lark-cli command failed: ${result.stderr.trim() || 'unknown error'}`);
    }
    return result.stdout;
  }

  async listFolder(folderToken: string): Promise<FolderFile[]> {
    return parseFolderFiles(await this.execute([
      'drive', 'files', 'list', '--folder-token', folderToken, '--page-all',
    ]));
  }

  async createDocument(folderToken: string, title: string, markdownPath: string): Promise<FeishuDocument> {
    return parseDocument(await this.execute([
      'docs', '+create', '--parent-token', folderToken, '--title', title,
      '--doc-format', 'markdown', '--content', `@${markdownPath}`,
    ]));
  }

  async updateDocument(document: FolderFile, markdownPath: string): Promise<FeishuDocument> {
    return parseDocument(await this.execute([
      'docs', '+update', '--doc', document.token, '--command', 'overwrite',
      '--doc-format', 'markdown', '--content', `@${markdownPath}`,
    ]), document.token, document.url);
  }

  async sendCard(receiveId: string, receiveIdType: string, card: string, key: string): Promise<void> {
    const recipientFlag = receiveIdType === 'chat_id' ? '--chat-id' : '--user-id';
    await this.execute([
      'im', '+messages-send', recipientFlag, receiveId, '--msg-type', 'interactive',
      '--content', card, '--idempotency-key', key,
    ]);
  }
}
