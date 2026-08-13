export interface FeedItem {
  title: string;
  link: string;
  publishedAt: string;
  description: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .trim();
}

function content(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'));
  if (!match?.[1]) return '';
  const cdata = match[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? match[1];
  return cdata.trim();
}

function tagAttribute(tag: string, attributeName: string): string {
  return tag.match(new RegExp(`\\s${attributeName}=["']([^"']*)["']`, 'i'))?.[1] ?? '';
}

function atomEntryLink(entry: string): string {
  const links = entry.match(/<link\b[^>]*\/?>/gi) ?? [];
  const alternate = links.find((link) => tagAttribute(link, 'rel').toLowerCase() === 'alternate');
  const implicitAlternate = links.find((link) => tagAttribute(link, 'rel') === '');
  return tagAttribute(alternate ?? implicitAlternate ?? links[0] ?? '', 'href');
}

export function parseFeedItems(xml: string): FeedItem[] {
  const atom = /<feed[\s>]/i.test(xml);
  const itemPattern = atom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi;
  const items: FeedItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) !== null) {
    const item = match[1] ?? '';
    const title = stripHtml(content(item, 'title'));
    const link = atom
      ? atomEntryLink(item)
      : content(item, 'link') || content(item, 'guid');
    const publishedAt = atom
      ? content(item, 'published') || content(item, 'updated')
      : content(item, 'pubDate') || content(item, 'dc:date') || content(item, 'date');
    const description = stripHtml(
      atom
        ? content(item, 'summary') || content(item, 'content')
        : content(item, 'description') || content(item, 'content:encoded'),
    ).slice(0, 500);
    if (title || link) items.push({ title, link, publishedAt, description });
  }
  return items;
}
