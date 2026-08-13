import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import {
  DIGEST_SCHEMA_VERSION,
  type CategoryId,
  type DigestReport,
} from '../src/contracts/digest';
import {
  createOpenAICompatibleClient,
  loadOpenAICompatibleConfig,
  type OpenAICompatibleClient,
} from '../src/providers/openai-compatible';
import { assertPublishableDigestReport } from '../src/validation/digest-report';
import {
  validateScoringOutput,
  validateSummaryOutput,
} from '../src/validation/model-output';
import { parseFeedItems } from '../src/sources/feed';
import {
  assertSourceCoverage,
  buildSourceHealthReport,
  type SourceFetchResult,
} from '../src/sources/health';
import {
  loadSourceRegistry,
  loadSourceThresholds,
  type SourceDefinition,
} from '../src/sources/registry';

// ============================================================================
// Constants
// ============================================================================

const FEED_FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 10;
const MODEL_BATCH_SIZE = 10;
const MAX_CONCURRENT_MODEL_CALLS = 2;


// ============================================================================
// Types
// ============================================================================

const CATEGORY_META: Record<CategoryId, { emoji: string; label: string }> = {
  'ai-ml':       { emoji: '🤖', label: 'AI / ML' },
  'security':    { emoji: '🔒', label: '安全' },
  'engineering': { emoji: '⚙️', label: '工程' },
  'tools':       { emoji: '🛠', label: '工具 / 开源' },
  'opinion':     { emoji: '💡', label: '观点 / 杂谈' },
  'other':       { emoji: '📝', label: '其他' },
};

interface Article {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
}

interface ScoredArticle extends Article {
  score: number;
  scoreBreakdown: {
    relevance: number;
    quality: number;
    timeliness: number;
  };
  category: CategoryId;
  keywords: string[];
  titleZh: string;
  summary: string;
  reason: string;
}

type AIClient = OpenAICompatibleClient;

// ============================================================================
// RSS/Atom Parsing (using Bun's built-in HTMLRewriter or manual XML parsing)
// ============================================================================


function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  
  // Try common RSS date formats
  // RFC 822: "Mon, 01 Jan 2024 00:00:00 GMT"
  const rfc822 = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (rfc822) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  
  return null;
}


// ============================================================================
// Feed Fetching
// ============================================================================

interface FeedFetchOutcome {
  articles: Article[];
  result: SourceFetchResult;
}

async function fetchFeed(source: SourceDefinition): Promise<FeedFetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-Daily-Digest/1.0 (RSS Reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const xml = await response.text();
    const items = parseFeedItems(xml);
    if (items.length === 0) throw new Error('feed contained no RSS/Atom items');
    const articles = items.map((item) => ({
      title: item.title,
      link: item.link,
      pubDate: parseDate(item.publishedAt) || new Date(0),
      description: item.description,
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.siteUrl,
    }));
    return {
      articles,
      result: { sourceId: source.id, status: 'success', articleCount: articles.length },
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.includes('abort') ? 'timeout' : rawMessage;
    console.warn(`[digest] ✗ ${source.name}: ${message}`);
    return {
      articles: [],
      result: { sourceId: source.id, status: 'failed', articleCount: 0, error: message },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllFeeds(sources: SourceDefinition[]): Promise<{
  articles: Article[];
  results: SourceFetchResult[];
}> {
  const allArticles: Article[] = [];
  const healthResults: SourceFetchResult[] = [];
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < sources.length; i += FEED_CONCURRENCY) {
    const batch = sources.slice(i, i + FEED_CONCURRENCY);
    const outcomes = await Promise.all(batch.map(fetchFeed));
    
    for (const outcome of outcomes) {
      healthResults.push(outcome.result);
      if (outcome.result.status === 'success') {
        allArticles.push(...outcome.articles);
        successCount++;
      } else {
        failCount++;
      }
    }
    
    const progress = Math.min(i + FEED_CONCURRENCY, sources.length);
    console.log(`[digest] Progress: ${progress}/${sources.length} feeds processed (${successCount} ok, ${failCount} failed)`);
  }
  
  console.log(`[digest] Fetched ${allArticles.length} articles from ${successCount} feeds (${failCount} failed)`);
  return { articles: allArticles, results: healthResults };
}

// ============================================================================
// AI Scoring
// ============================================================================

function buildScoringPrompt(articles: Array<{ index: number; title: string; description: string; sourceName: string }>): string {
  const articlesList = articles.map(a =>
    `Index ${a.index}: [${a.sourceName}] ${a.title}\n${a.description.slice(0, 300)}`
  ).join('\n\n---\n\n');

  return `你是一个技术内容策展人，正在为一份面向技术爱好者的每日精选摘要筛选文章。

请对以下文章进行三个维度的评分（1-10 整数，10 分最高），并为每篇文章分配一个分类标签和提取 2-4 个关键词。

## 评分维度

### 1. 相关性 (relevance) - 对技术/编程/AI/互联网从业者的价值
- 10: 所有技术人都应该知道的重大事件/突破
- 7-9: 对大部分技术从业者有价值
- 4-6: 对特定技术领域有价值
- 1-3: 与技术行业关联不大

### 2. 质量 (quality) - 文章本身的深度和写作质量
- 10: 深度分析，原创洞见，引用丰富
- 7-9: 有深度，观点独到
- 4-6: 信息准确，表达清晰
- 1-3: 浅尝辄止或纯转述

### 3. 时效性 (timeliness) - 当前是否值得阅读
- 10: 正在发生的重大事件/刚发布的重要工具
- 7-9: 近期热点相关
- 4-6: 常青内容，不过时
- 1-3: 过时或无时效价值

## 分类标签（必须从以下选一个）
- ai-ml: AI、机器学习、LLM、深度学习相关
- security: 安全、隐私、漏洞、加密相关
- engineering: 软件工程、架构、编程语言、系统设计
- tools: 开发工具、开源项目、新发布的库/框架
- opinion: 行业观点、个人思考、职业发展、文化评论
- other: 以上都不太适合的

## 关键词提取
提取 2-4 个最能代表文章主题的关键词（用英文，简短，如 "Rust", "LLM", "database", "performance"）

## 待评分文章

${articlesList}

请严格按 JSON 格式返回，不要包含 markdown 代码块或其他文字：
{
  "results": [
    {
      "index": 0,
      "relevance": 8,
      "quality": 7,
      "timeliness": 9,
      "category": "engineering",
      "keywords": ["Rust", "compiler", "performance"]
    }
  ]
}`;
}

async function scoreArticlesWithAI(
  articles: Article[],
  aiClient: AIClient
): Promise<Map<number, { relevance: number; quality: number; timeliness: number; category: CategoryId; keywords: string[] }>> {
  const allScores = new Map<number, { relevance: number; quality: number; timeliness: number; category: CategoryId; keywords: string[] }>();
  
  const indexed = articles.map((article, index) => ({
    index,
    title: article.title,
    description: article.description,
    sourceName: article.sourceName,
  }));
  
  const batches: typeof indexed[] = [];
  for (let i = 0; i < indexed.length; i += MODEL_BATCH_SIZE) {
    batches.push(indexed.slice(i, i + MODEL_BATCH_SIZE));
  }
  
  console.log(`[digest] AI scoring: ${articles.length} articles in ${batches.length} batches`);
  
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_MODEL_CALLS) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT_MODEL_CALLS);
    const promises = batchGroup.map(async (batch) => {
      const prompt = buildScoringPrompt(batch);
      const responseText = await aiClient.call(prompt);
      const results = validateScoringOutput(
        responseText,
        batch.map((item) => item.index),
      );
      for (const result of results) {
        allScores.set(result.index, result);
      }
    });
    
    await Promise.all(promises);
    console.log(`[digest] Scoring progress: ${Math.min(i + MAX_CONCURRENT_MODEL_CALLS, batches.length)}/${batches.length} batches`);
  }
  
  return allScores;
}

// ============================================================================
// AI Summarization
// ============================================================================

function buildSummaryPrompt(
  articles: Array<{ index: number; title: string; description: string; sourceName: string; link: string }>,
  lang: 'zh' | 'en'
): string {
  const articlesList = articles.map(a =>
    `Index ${a.index}: [${a.sourceName}] ${a.title}\nURL: ${a.link}\n${a.description.slice(0, 800)}`
  ).join('\n\n---\n\n');

  const langInstruction = lang === 'zh'
    ? '请用中文撰写摘要和推荐理由。如果原文是英文，请翻译为中文。标题翻译也用中文。'
    : 'Write summaries, reasons, and title translations in English.';

  return `你是一个技术内容摘要专家。请为以下文章完成三件事：

1. **中文标题** (titleZh): 将英文标题翻译成自然的中文。如果原标题已经是中文则保持不变。
2. **摘要** (summary): 4-6 句话的结构化摘要，让读者不点进原文也能了解核心内容。包含：
   - 文章讨论的核心问题或主题（1 句）
   - 关键论点、技术方案或发现（2-3 句）
   - 结论或作者的核心观点（1 句）
3. **推荐理由** (reason): 1 句话说明"为什么值得读"，区别于摘要（摘要说"是什么"，推荐理由说"为什么"）。

${langInstruction}

摘要要求：
- 直接说重点，不要用"本文讨论了..."、"这篇文章介绍了..."这种开头
- 包含具体的技术名词、数据、方案名称或观点
- 保留关键数字和指标（如性能提升百分比、用户数、版本号等）
- 如果文章涉及对比或选型，要点出比较对象和结论
- 目标：读者花 30 秒读完摘要，就能决定是否值得花 10 分钟读原文

## 待摘要文章

${articlesList}

请严格按 JSON 格式返回：
{
  "results": [
    {
      "index": 0,
      "titleZh": "中文翻译的标题",
      "summary": "摘要内容...",
      "reason": "推荐理由..."
    }
  ]
}`;
}

async function summarizeArticles(
  articles: Array<Article & { index: number }>,
  aiClient: AIClient,
  lang: 'zh' | 'en'
): Promise<Map<number, { titleZh: string; summary: string; reason: string }>> {
  const summaries = new Map<number, { titleZh: string; summary: string; reason: string }>();
  
  const indexed = articles.map(a => ({
    index: a.index,
    title: a.title,
    description: a.description,
    sourceName: a.sourceName,
    link: a.link,
  }));
  
  const batches: typeof indexed[] = [];
  for (let i = 0; i < indexed.length; i += MODEL_BATCH_SIZE) {
    batches.push(indexed.slice(i, i + MODEL_BATCH_SIZE));
  }
  
  console.log(`[digest] Generating summaries for ${articles.length} articles in ${batches.length} batches`);
  
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_MODEL_CALLS) {
    const batchGroup = batches.slice(i, i + MAX_CONCURRENT_MODEL_CALLS);
    const promises = batchGroup.map(async (batch) => {
      const prompt = buildSummaryPrompt(batch, lang);
      const responseText = await aiClient.call(prompt);
      const results = validateSummaryOutput(
        responseText,
        batch.map((item) => item.index),
      );
      for (const result of results) {
        summaries.set(result.index, {
          titleZh: result.titleLocalized,
          summary: result.summary,
          reason: result.reason,
        });
      }
    });
    
    await Promise.all(promises);
    console.log(`[digest] Summary progress: ${Math.min(i + MAX_CONCURRENT_MODEL_CALLS, batches.length)}/${batches.length} batches`);
  }
  
  return summaries;
}

// ============================================================================
// AI Highlights (Today's Trends)
// ============================================================================

async function generateHighlights(
  articles: ScoredArticle[],
  aiClient: AIClient,
  lang: 'zh' | 'en'
): Promise<string> {
  const articleList = articles.slice(0, 10).map((a, i) =>
    `${i + 1}. [${a.category}] ${a.titleZh || a.title} — ${a.summary.slice(0, 100)}`
  ).join('\n');

  const langNote = lang === 'zh' ? '用中文回答。' : 'Write in English.';

  const prompt = `根据以下今日精选技术文章列表，写一段 3-5 句话的"今日看点"总结。
要求：
- 提炼出今天技术圈的 2-3 个主要趋势或话题
- 不要逐篇列举，要做宏观归纳
- 风格简洁有力，像新闻导语
${langNote}

文章列表：
${articleList}

直接返回纯文本总结，不要 JSON，不要 markdown 格式。`;

  const text = await aiClient.call(prompt);
  return text.trim();
}

// ============================================================================
// Visualization Helpers
// ============================================================================

function humanizeTime(pubDate: Date): string {
  const diffMs = Date.now() - pubDate.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return pubDate.toISOString().slice(0, 10);
}

function formatDateReadable(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function generateKeywordBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  if (sorted.length === 0) return '';

  const labels = sorted.map(([k]) => `"${k}"`).join(', ');
  const values = sorted.map(([, v]) => v).join(', ');
  const maxVal = sorted[0][1];

  let chart = '```mermaid\n';
  chart += `xychart-beta horizontal\n`;
  chart += `    title "高频关键词"\n`;
  chart += `    x-axis [${labels}]\n`;
  chart += `    y-axis "出现次数" 0 --> ${maxVal + 2}\n`;
  chart += `    bar [${values}]\n`;
  chart += '```\n';

  return chart;
}

function generateCategoryPieChart(articles: ScoredArticle[]): string {
  const catCount = new Map<CategoryId, number>();
  for (const a of articles) {
    catCount.set(a.category, (catCount.get(a.category) || 0) + 1);
  }

  if (catCount.size === 0) return '';

  const sorted = Array.from(catCount.entries()).sort((a, b) => b[1] - a[1]);

  let chart = '```mermaid\n';
  chart += `pie showData\n`;
  chart += `    title "文章分类分布"\n`;
  for (const [cat, count] of sorted) {
    const meta = CATEGORY_META[cat];
    chart += `    "${meta.emoji} ${meta.label}" : ${count}\n`;
  }
  chart += '```\n';

  return chart;
}

function generateAsciiBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) return '';

  const maxVal = sorted[0][1];
  const maxBarWidth = 20;
  const maxLabelLen = Math.max(...sorted.map(([k]) => k.length));

  let chart = '```\n';
  for (const [label, value] of sorted) {
    const barLen = Math.max(1, Math.round((value / maxVal) * maxBarWidth));
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBarWidth - barLen);
    chart += `${label.padEnd(maxLabelLen)} │ ${bar} ${value}\n`;
  }
  chart += '```\n';

  return chart;
}

function generateTagCloud(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  if (sorted.length === 0) return '';

  return sorted
    .map(([word, count], i) => i < 3 ? `**${word}**(${count})` : `${word}(${count})`)
    .join(' · ');
}

// ============================================================================
// Report Generation
// ============================================================================

function generateDigestReport(articles: ScoredArticle[], highlights: string, stats: {
  totalFeeds: number;
  successFeeds: number;
  totalArticles: number;
  filteredArticles: number;
  hours: number;
  lang: string;
}): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const dateReadable = formatDateReadable(dateStr);
  
  let report = `# 📰 ${dateReadable}\n\n`;
  report += `> 来自 Karpathy 推荐的 ${stats.totalFeeds} 个顶级技术博客，AI 精选 Top ${articles.length}\n\n`;

  // ── Today's Highlights ──
  if (highlights) {
    report += `## 📝 今日看点\n\n`;
    report += `${highlights}\n\n`;
    report += `---\n\n`;
  }

  // ── Top 3 Deep Showcase ──
  if (articles.length >= 3) {
    report += `## 🏆 今日必读\n\n`;
    for (let i = 0; i < Math.min(3, articles.length); i++) {
      const a = articles[i];
      const medal = ['🥇', '🥈', '🥉'][i];
      const catMeta = CATEGORY_META[a.category];
      
      report += `${medal} **${a.titleZh || a.title}**\n\n`;
      report += `[${a.title}](${a.link}) — ${a.sourceName} · ${humanizeTime(a.pubDate)} · ${catMeta.emoji} ${catMeta.label}\n\n`;
      report += `> ${a.summary}\n\n`;
      if (a.reason) {
        report += `💡 **为什么值得读**: ${a.reason}\n\n`;
      }
      if (a.keywords.length > 0) {
        report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      }
    }
    report += `---\n\n`;
  }

  // ── Visual Statistics ──
  report += `## 📊 数据概览\n\n`;

  report += `| 扫描源 | 抓取文章 | 时间范围 | 精选 |\n`;
  report += `|:---:|:---:|:---:|:---:|\n`;
  report += `| ${stats.successFeeds}/${stats.totalFeeds} | ${stats.totalArticles} 篇 → ${stats.filteredArticles} 篇 | ${stats.hours}h | **${articles.length} 篇** |\n\n`;

  const pieChart = generateCategoryPieChart(articles);
  if (pieChart) {
    report += `### 分类分布\n\n${pieChart}\n`;
  }

  const barChart = generateKeywordBarChart(articles);
  if (barChart) {
    report += `### 高频关键词\n\n${barChart}\n`;
  }

  const asciiChart = generateAsciiBarChart(articles);
  if (asciiChart) {
    report += `<details>\n<summary>📈 纯文本关键词图（终端友好）</summary>\n\n${asciiChart}\n</details>\n\n`;
  }

  const tagCloud = generateTagCloud(articles);
  if (tagCloud) {
    report += `### 🏷️ 话题标签\n\n${tagCloud}\n\n`;
  }

  report += `---\n\n`;

  // ── Category-Grouped Articles ──
  const categoryGroups = new Map<CategoryId, ScoredArticle[]>();
  for (const a of articles) {
    const list = categoryGroups.get(a.category) || [];
    list.push(a);
    categoryGroups.set(a.category, list);
  }

  const sortedCategories = Array.from(categoryGroups.entries())
    .sort((a, b) => b[1].length - a[1].length);

  let globalIndex = 0;
  for (const [catId, catArticles] of sortedCategories) {
    const catMeta = CATEGORY_META[catId];
    report += `## ${catMeta.emoji} ${catMeta.label}\n\n`;

    for (const a of catArticles) {
      globalIndex++;
      const scoreTotal = a.scoreBreakdown.relevance + a.scoreBreakdown.quality + a.scoreBreakdown.timeliness;

      report += `### ${globalIndex}. ${a.titleZh || a.title}\n\n`;
      report += `[${a.title}](${a.link}) — **${a.sourceName}** · ${humanizeTime(a.pubDate)} · ⭐ ${scoreTotal}/30\n\n`;
      report += `> ${a.summary}\n\n`;
      if (a.keywords.length > 0) {
        report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      }
      report += `---\n\n`;
    }
  }

  // ── Footer ──
  report += `*生成于 ${dateStr} ${now.toISOString().split('T')[1]?.slice(0, 5) || ''} | 扫描 ${stats.successFeeds} 源 → 获取 ${stats.totalArticles} 篇 → 精选 ${articles.length} 篇*\n`;
  report += `*基于 [Hacker News Popularity Contest 2025](https://refactoringenglish.com/tools/hn-popularity/) RSS 源列表，由 [Andrej Karpathy](https://x.com/karpathy) 推荐*\n`;


  return report;
}

// ============================================================================
// RSS Feed Generation
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRFC822(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

function markdownToHtmlFragment(md: string): string {
  let html = md;
  // Strip the first H1 title (RSS item already shows it)
  html = html.replace(/^# .+\n\n/, '');
  // Strip <details> blocks (terminal-only charts, not useful in RSS)
  html = html.replace(/<details>[\s\S]*?<\/details>/g, '');
  // Convert mermaid code blocks to plain text (RSS readers can't render mermaid)
  html = html.replace(/```mermaid\n([\s\S]*?)```/g, (_, content) => {
    const lines = content.trim().split('\n').filter((line: string) => !line.startsWith('pie ') && !line.startsWith('xychart') && !line.startsWith('    title') && !line.startsWith('    x-axis') && !line.startsWith('    y-axis'));
    return `<pre style="color:#aaa;font-size:12px;">${lines.join('\n')}</pre>`;
  });
  // Convert plain code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre style="color:#ccc;background:#1a1a2e;padding:8px 12px;border-radius:4px;font-size:13px;overflow-x:auto;">$1</pre>');
  // Convert markdown tables to HTML tables
  html = html.replace(/^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+:\|\n?)+)/gm, (_match, headerRow, bodyRows) => {
    const headers = headerRow.split('|').map((c: string) => c.trim()).filter(Boolean);
    const rows = bodyRows.trim().split('\n').map((row: string) =>
      row.split('|').map((c: string) => c.trim()).filter(Boolean)
    );
    let table = '<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:14px;">';
    table += '<thead><tr>' + headers.map((h: string) => `<th style="border:1px solid #444;padding:6px 10px;text-align:center;background:#1a1a2e;">${h}</th>`).join('') + '</tr></thead>';
    table += '<tbody>' + rows.map((row: string[]) => '<tr>' + row.map((cell: string) => `<td style="border:1px solid #444;padding:6px 10px;text-align:center;">${cell}</td>`).join('') + '</tr>').join('') + '</tbody>';
    table += '</table>';
    return table;
  });
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid #555;margin:4px 0;padding:4px 12px;color:#aaa;">$1</blockquote>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #333;margin:12px 0;"/>');
  // Paragraphs: convert double newlines
  html = html.replace(/\n\n+/g, '</p><p>');
  html = `<p>${html}</p>`;
  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

interface DigestDay {
  date: string;        // YYYY-MM-DD
  title: string;       // RSS item title
  htmlContent: string;  // Full digest as HTML fragment
  link: string;         // Link to the markdown file
  pubDate: string;      // RFC 822 date string
}

function generateRSSFeed(todayDigest: DigestDay, pastDigests: DigestDay[]): string {
  const feedUrl = 'https://allenx-li.github.io/ai-daily-digest/feed.xml';
  const siteUrl = 'https://allenx-li.github.io/ai-daily-digest/';
  const allDigests = [todayDigest, ...pastDigests];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n`;
  xml += `  <channel>\n`;
  xml += `    <title>AI Blog Daily Picks</title>\n`;
  xml += `    <link>${escapeXml(siteUrl)}</link>\n`;
  xml += `    <description>AI-curated daily digest from 90 top tech blogs (Karpathy's list)</description>\n`;
  xml += `    <language>zh-cn</language>\n`;
  xml += `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>\n`;
  xml += `    <lastBuildDate>${escapeXml(todayDigest.pubDate)}</lastBuildDate>\n`;
  xml += `    <generator>AI Daily Digest</generator>\n`;
  xml += `    <image>\n`;
  xml += `      <url>${escapeXml(siteUrl)}logo.png</url>\n`;
  xml += `      <title>AI Blog Daily Picks</title>\n`;
  xml += `      <link>${escapeXml(siteUrl)}</link>\n`;
  xml += `    </image>\n`;

  for (const day of allDigests) {
    xml += `    <item>\n`;
    xml += `      <title>${escapeXml(day.title)}</title>\n`;
    xml += `      <link>${escapeXml(day.link)}</link>\n`;
    xml += `      <description><![CDATA[${day.htmlContent}]]></description>\n`;
    xml += `      <pubDate>${escapeXml(day.pubDate)}</pubDate>\n`;
    xml += `    </item>\n`;
  }

  xml += `  </channel>\n`;
  xml += `</rss>\n`;

  return xml;
}

// ============================================================================
// CLI
// ============================================================================

function printUsage(): never {
  console.log(`AI Daily Digest - AI-powered RSS digest from 90 top tech blogs

Usage:
  bun scripts/digest.ts [options]

Options:
  --hours <n>       Time range in hours (default: 48)
  --top-n <n>       Number of top articles to include (default: 15)
  --lang <lang>     Summary language: zh or en (default: zh)
  --output <path>   Output file path (default: ./digest-YYYYMMDD.md)
  --help            Show this help

Environment:
  OPENAI_API_KEY                  Required provider key
  OPENAI_BASE_URL                 Base URL (default: https://api.openai.com/v1)
  OPENAI_MODEL                    Model (default: gpt-4o-mini)
  OPENAI_API_STYLE                responses or chat_completions (default: responses)
  OPENAI_RESPONSES_PATH           Responses endpoint path (default: /responses)
  OPENAI_CHAT_COMPLETIONS_PATH    Chat Completions path (default: /chat/completions)

Examples:
  bun scripts/digest.ts --hours 24 --top-n 10 --lang zh
  bun scripts/digest.ts --hours 72 --top-n 20 --lang en --output ./my-digest.md
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();
  
  let hours = 48;
  let topN = 15;
  let lang: 'zh' | 'en' = 'zh';
  let outputPath = '';
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--hours' && args[i + 1]) {
      hours = parseInt(args[++i]!, 10);
    } else if (arg === '--top-n' && args[i + 1]) {
      topN = parseInt(args[++i]!, 10);
    } else if (arg === '--lang' && args[i + 1]) {
      lang = args[++i] as 'zh' | 'en';
    } else if (arg === '--output' && args[i + 1]) {
      outputPath = args[++i]!;
    }
  }

  if (!Number.isInteger(hours) || hours < 1) throw new Error('--hours must be a positive integer');
  if (!Number.isInteger(topN) || topN < 3) throw new Error('--top-n must be an integer of at least 3');
  if (lang !== 'zh' && lang !== 'en') throw new Error('--lang must be zh or en');

  const openAIConfig = loadOpenAICompatibleConfig();
  const aiClient = createOpenAICompatibleClient(openAIConfig);
  const sourceRegistry = await loadSourceRegistry();
  const sourceThresholds = loadSourceThresholds();
  const activeSources = sourceRegistry.sources.filter((source) => source.status === 'active');
  
  if (!outputPath) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    outputPath = `./digest-${dateStr}.md`;
  }
  
  console.log(`[digest] === AI Daily Digest ===`);
  console.log(`[digest] Time range: ${hours} hours`);
  console.log(`[digest] Top N: ${topN}`);
  console.log(`[digest] Language: ${lang}`);
  console.log(`[digest] Output: ${outputPath}`);
  console.log(
    `[digest] AI provider: OpenAI-compatible ${openAIConfig.apiStyle} ` +
      `(${openAIConfig.baseUrl}, model=${openAIConfig.model})`,
  );
  console.log('');
  
  console.log(`[digest] Step 1/5: Fetching ${activeSources.length} active RSS feeds...`);
  const fetchOutcome = await fetchAllFeeds(activeSources);
  const allArticles = fetchOutcome.articles;
  
  console.log(`[digest] Step 2/5: Filtering by time range (${hours} hours)...`);
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const recentArticles = allArticles.filter(a => a.pubDate.getTime() > cutoffTime.getTime());
  
  console.log(`[digest] Found ${recentArticles.length} articles within last ${hours} hours`);
  
  const sourceHealth = buildSourceHealthReport(
    sourceRegistry,
    fetchOutcome.results,
    recentArticles.length,
    sourceThresholds,
  );
  const sourceHealthPath = join(dirname(outputPath), 'source-health.json');
  await mkdir(dirname(sourceHealthPath), { recursive: true });
  await writeFile(sourceHealthPath, `${JSON.stringify(sourceHealth, null, 2)}\n`);
  console.log(
    `[digest] Source health: ${sourceHealth.successfulSources}/${sourceHealth.activeSources} ` +
      `active feeds (${(sourceHealth.coverageRatio * 100).toFixed(1)}%); report=${sourceHealthPath}`,
  );
  assertSourceCoverage(sourceHealth);
  
  console.log(`[digest] Step 3/5: AI scoring ${recentArticles.length} articles...`);
  const scores = await scoreArticlesWithAI(recentArticles, aiClient);
  
  const scoredArticles = recentArticles.map((article, index) => {
    const score = scores.get(index);
    if (!score) throw new Error(`validated scoring result missing index ${index}`);
    return {
      ...article,
      totalScore: score.relevance + score.quality + score.timeliness,
      breakdown: score,
    };
  });
  
  scoredArticles.sort((a, b) => b.totalScore - a.totalScore);
  const topArticles = scoredArticles.slice(0, topN);
  
  console.log(`[digest] Top ${topN} articles selected (score range: ${topArticles[topArticles.length - 1]?.totalScore || 0} - ${topArticles[0]?.totalScore || 0})`);
  
  console.log(`[digest] Step 4/5: Generating AI summaries...`);
  const indexedTopArticles = topArticles.map((a, i) => ({ ...a, index: i }));
  const summaries = await summarizeArticles(indexedTopArticles, aiClient, lang);
  
  const finalArticles: ScoredArticle[] = topArticles.map((a, i) => {
    const sm = summaries.get(i);
    if (!sm) throw new Error(`validated summary result missing index ${i}`);
    return {
      title: a.title,
      link: a.link,
      pubDate: a.pubDate,
      description: a.description,
      sourceId: a.sourceId,
      sourceName: a.sourceName,
      sourceUrl: a.sourceUrl,
      score: a.totalScore,
      scoreBreakdown: {
        relevance: a.breakdown.relevance,
        quality: a.breakdown.quality,
        timeliness: a.breakdown.timeliness,
      },
      category: a.breakdown.category,
      keywords: a.breakdown.keywords,
      titleZh: sm.titleZh,
      summary: sm.summary,
      reason: sm.reason,
    };
  });
  
  console.log(`[digest] Step 5/5: Generating today's highlights...`);
  const highlights = await generateHighlights(finalArticles, aiClient, lang);
  
  const digestReport: DigestReport = {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    language: lang,
    highlights,
    articles: finalArticles.map((article) => ({
      title: article.title,
      titleLocalized: article.titleZh,
      url: article.link,
      publishedAt: article.pubDate.toISOString(),
      sourceId: article.sourceId,
      sourceName: article.sourceName,
      sourceUrl: article.sourceUrl,
      category: article.category,
      keywords: article.keywords,
      summary: article.summary,
      reason: article.reason,
      scores: article.scoreBreakdown,
    })),
    stats: {
      configuredSources: sourceHealth.configuredSources,
      successfulSources: sourceHealth.successfulSources,
      fetchedArticles: allArticles.length,
      recentArticles: recentArticles.length,
      selectedArticles: finalArticles.length,
      timeRangeHours: hours,
    },
  };
  assertPublishableDigestReport(digestReport);

  const report = generateDigestReport(finalArticles, highlights, {
    totalFeeds: sourceHealth.activeSources,
    successFeeds: sourceHealth.successfulSources,
    totalArticles: allArticles.length,
    filteredArticles: recentArticles.length,
    hours,
    lang,
  });
  
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report);
  
  // Generate RSS feed: one item per day, accumulating past digests
  const dateStr = new Date().toISOString().slice(0, 10);
  const mdFilename = outputPath.split('/').pop() || `digest-${dateStr}.md`;
  const todayDigest: DigestDay = {
    date: dateStr,
    title: `📰 AI Blog Daily Picks — ${formatDateReadable(dateStr)}`,
    htmlContent: markdownToHtmlFragment(report),
    link: `https://allenx-li.github.io/ai-daily-digest/${mdFilename.replace('.md', '.html')}`,
    pubDate: toRFC822(new Date()),
  };

  // Load past digest markdown files from the output directory for RSS history
  const pastDigests: DigestDay[] = [];
  try {
    const outputDir = dirname(outputPath);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(outputDir);
    const pastMdFiles = files
      .filter(f => f.startsWith('digest-') && f.endsWith('.md') && f !== mdFilename)
      .sort()
      .reverse()
      .slice(0, 30); // Keep last 30 days in RSS

    for (const f of pastMdFiles) {
      try {
        const pastContent = await readFile(join(outputDir, f), 'utf-8');
        const pastDate = f.replace('digest-', '').replace('.md', '');
        // Extract YYYY-MM-DD from filename (digest-20260502.md → 2026-05-02)
        const formattedDate = `${pastDate.slice(0, 4)}-${pastDate.slice(4, 6)}-${pastDate.slice(6, 8)}`;
        pastDigests.push({
          date: formattedDate,
          title: `📰 AI Blog Daily Picks — ${formatDateReadable(formattedDate)}`,
          htmlContent: markdownToHtmlFragment(pastContent),
          link: `https://allenx-li.github.io/ai-daily-digest/${f.replace('.md', '.html')}`,
          pubDate: toRFC822(new Date(formattedDate + 'T02:00:00Z')),
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Output dir listing failed, skip past digests
  }

  const rssFeed = generateRSSFeed(todayDigest, pastDigests);
  const rssPath = join(dirname(outputPath), 'feed.xml');
  await writeFile(rssPath, rssFeed);

  console.log(`[digest] 📡 RSS: ${rssPath} (${1 + pastDigests.length} days)`);
  
  console.log('');
  console.log(`[digest] ✅ Done!`);
  console.log(`[digest] 📁 Report: ${outputPath}`);
  console.log(`[digest] 📡 RSS: ${rssPath}`);
  console.log(`[digest] 📊 Stats: ${sourceHealth.successfulSources} sources → ${allArticles.length} articles → ${recentArticles.length} recent → ${finalArticles.length} selected`);
  
  if (finalArticles.length > 0) {
    console.log('');
    console.log(`[digest] 🏆 Top 3 Preview:`);
    for (let i = 0; i < Math.min(3, finalArticles.length); i++) {
      const a = finalArticles[i];
      console.log(`  ${i + 1}. ${a.titleZh || a.title}`);
      console.log(`     ${a.summary.slice(0, 80)}...`);
    }
  }
}

await main().catch((err) => {
  console.error(`[digest] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
