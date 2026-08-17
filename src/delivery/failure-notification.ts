import { shanghaiDate } from './feishu';

export interface DigestFailureNotification {
  date: string;
  runUrl: string;
  runId: string;
  runAttempt: string;
}

export function digestFailureIdempotencyKey(input: DigestFailureNotification): string {
  const key = `ai-digest-fail-${input.date}-${input.runId}-${input.runAttempt}`;
  if (key.length > 50) throw new Error('failure notification idempotency key exceeds 50 characters');
  return key;
}

export function buildDigestFailureCard(input: DigestFailureNotification): string {
  const title = `AI Daily Digest · ${input.date} 生成失败`;
  return JSON.stringify({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: title },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: '生成流程未完成，今日日报未发布' },
      template: 'red',
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: '需人工处理' }, color: 'red' },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: '日报生成流程失败。GitHub 归档、飞书 Docx 和日报卡片均未发布。\n\n请打开 Actions 日志查看准确原因，处理后手动运行。',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看失败日志' },
          type: 'primary_filled',
          width: 'fill',
          behaviors: [{ type: 'open_url', default_url: input.runUrl }],
        },
      ],
    },
  });
}

export function failureNotificationDate(now = new Date()): string {
  return shanghaiDate(now);
}
