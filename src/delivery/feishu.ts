export const FEISHU_CLI_VERSION = '1.0.86' as const;
export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai' as const;

export interface FolderFile {
  token: string;
  name: string;
  type: string;
  url?: string;
}

export interface FeishuDocument {
  token: string;
  url: string;
}

export interface FeishuGateway {
  listFolder(folderToken: string): Promise<FolderFile[]>;
  createDocument(folderToken: string, title: string, markdownPath: string): Promise<FeishuDocument>;
  updateDocument(document: FolderFile, markdownPath: string): Promise<FeishuDocument>;
  restoreDocumentTitle(document: FeishuDocument, title: string): Promise<void>;
  sendCard(receiveId: string, receiveIdType: string, card: string, idempotencyKey: string): Promise<void>;
}

export interface PublishDailyDigestInput {
  gateway: FeishuGateway;
  now: Date;
  folderToken: string;
  receiveId: string;
  receiveIdType: string;
  markdownPath: string;
  archivePushed: boolean;
}

export interface PublishDailyDigestResult {
  action: 'created' | 'updated';
  title: string;
  document: FeishuDocument;
  idempotencyKey: string;
}

export function shanghaiDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function dailyDigestTitle(now: Date): string {
  return `AI Daily Digest · ${shanghaiDate(now)}`;
}

export function dailyCardIdempotencyKey(now: Date): string {
  const key = `ai-digest-${shanghaiDate(now)}`;
  if (key.length > 50) throw new Error('card idempotency key exceeds 50 characters');
  return key;
}

export function findExactDailyDocument(files: FolderFile[], title: string): FolderFile | undefined {
  const matches = files.filter((file) => file.name === title && file.type === 'docx');
  if (matches.length > 1) {
    throw new Error(`multiple Docx files exactly match ${JSON.stringify(title)}; refusing to publish`);
  }
  return matches[0];
}

export function verifyWrittenDailyDocument(
  files: FolderFile[],
  title: string,
  writtenToken: string,
): FolderFile {
  const matches = files.filter((file) => file.name === title && file.type === 'docx');
  if (matches.length !== 1) {
    throw new Error(
      `post-write verification expected exactly one Docx matching ${JSON.stringify(title)}; found ${matches.length}`,
    );
  }
  if (matches[0]!.token !== writtenToken) {
    throw new Error(
      `post-write verification token mismatch: wrote ${JSON.stringify(writtenToken)}, found ${JSON.stringify(matches[0]!.token)}`,
    );
  }
  return matches[0]!;
}

export function buildDigestCard(title: string, documentUrl: string): string {
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `${title} 已生成` },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: '已归档并同步到飞书文档' },
      template: 'green',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: '完成' }, color: 'green' },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'green-50',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '12px',
              vertical_spacing: '4px',
              elements: [
                { tag: 'markdown', content: '**今日 AI 技术精选已就绪**' },
                {
                  tag: 'markdown',
                  content: "<font color='grey'>源抓取、模型生成与严格校验均已完成。</font>",
                  text_size: 'notation',
                },
              ],
            },
          ],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开日报' },
          type: 'primary_filled',
          width: 'fill',
          behaviors: [{ type: 'open_url', default_url: documentUrl }],
        },
      ],
    },
  };
  return JSON.stringify(card);
}

export async function publishDailyDigest(input: PublishDailyDigestInput): Promise<PublishDailyDigestResult> {
  if (!input.archivePushed) {
    throw new Error('Git archive push must succeed before Feishu publication');
  }

  const title = dailyDigestTitle(input.now);
  const files = await input.gateway.listFolder(input.folderToken);
  const existing = findExactDailyDocument(files, title);
  const document = existing
    ? await input.gateway.updateDocument(existing, input.markdownPath)
    : await input.gateway.createDocument(input.folderToken, title, input.markdownPath);
  await input.gateway.restoreDocumentTitle(document, title);
  verifyWrittenDailyDocument(
    await input.gateway.listFolder(input.folderToken),
    title,
    document.token,
  );
  const idempotencyKey = dailyCardIdempotencyKey(input.now);
  if (!existing) {
    await input.gateway.sendCard(
      input.receiveId,
      input.receiveIdType,
      buildDigestCard(title, document.url),
      idempotencyKey,
    );
  }

  return { action: existing ? 'updated' : 'created', title, document, idempotencyKey };
}
