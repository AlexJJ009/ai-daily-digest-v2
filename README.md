# AI Daily Digest V2

AI Daily Digest V2 collects recent posts from a curated source registry, asks
an OpenAI-compatible model to score and summarize them, validates the result,
and renders the accepted report as Markdown and RSS.

This repository is a maintained fork of
[AllenX-Li/ai-daily-digest](https://github.com/AllenX-Li/ai-daily-digest).
The original project and this derivative are distributed under the MIT License;
see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Fork and branch model

- `upstream/main` tracks `AllenX-Li/ai-daily-digest`.
- `origin/main` mirrors upstream history and does not carry V2 customization.
- `origin/v2` is the long-lived integration branch for V2 changes.
- Delivery work branches from a frozen `origin/v2` commit and returns through a
  reviewed pull request. Delivery agents do not merge the PR or change the
  GitHub default branch.

The initial V2 base is
`9f9f5cecdd76cb33087400ffd8004489801b6250`. To sync upstream, first fetch both
remotes, update `origin/main` as a clean mirror, then integrate the selected
upstream range into `v2` through a dedicated reviewed branch. Never force-push
V2 customization onto `main`.

## Runtime and dependencies

The project uses Bun `1.3.11`, declared through `packageManager`, and exact
development dependency versions in `package.json` and `bun.lock`. Install and
verify with:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run check:fork
```

`src/contracts/digest.ts` is the stable typed boundary between model output,
validation, and rendering. JSON fixtures under `tests/fixtures/reports/` are the
contract examples used by Bun tests.

## Local execution

V2 uses one OpenAI-compatible provider and does not require a Gemini key.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Bearer credential; never commit it |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Provider model name |
| `OPENAI_API_STYLE` | `responses` | `responses` or `chat_completions` |
| `OPENAI_RESPONSES_PATH` | `/responses` | Responses endpoint path |
| `OPENAI_CHAT_COMPLETIONS_PATH` | `/chat/completions` | Chat Completions endpoint path |

The provider retries transient transport, `408`, `409`, `429`, and `5xx`
failures up to three attempts. It does not turn an empty or malformed successful
response into a report.

Before writing Markdown or RSS, the publication gate validates every requested
model result and the assembled typed report. The centralized defaults require
at least 3 selected articles (the report's useful Top 3), 60 summary characters
and 3 sentences per article, a 10-character recommendation, a 20-character
highlight, 2 keywords, unique article URLs, valid 1–10 integer scores, and no
more than half the report in the fallback `other` category. These defaults live
in `src/validation/digest-report.ts`; source coverage thresholds are separate
runtime configuration described below.

```bash
export OPENAI_API_KEY=replace-locally
export OPENAI_API_STYLE=responses
bun scripts/digest.ts --hours 48 --top-n 15 --lang zh --output ./digest.md
```

The command exits non-zero before writing publication artifacts when provider,
report, or minimum source-coverage validation fails.

## Source registry and health gate

`config/sources.json` is the only source catalog. Every entry has a stable ID,
feed/site URL, `active` or `deprecated` status, and an audit reason. Duplicate
IDs or feed URLs, missing reasons, invalid URLs, and unknown statuses fail at
startup. Do not add a second source list in code.

The digest writes `source-health.json` beside the requested report before model
calls. Its machine-readable entries include healthy, failed, and deprecated
sources, article counts, failure text, coverage, configured thresholds, and the
gate result. A failed feed is visible but does not stop a run that still meets
both thresholds.

| Variable | Default | Rationale |
| --- | --- | --- |
| `MIN_SOURCE_COVERAGE_RATIO` | `0.5` | Require a majority boundary without tying the rule to today's catalog size |
| `MIN_RECENT_ARTICLES` | `3` | Preserve the report's minimum useful Top 3 |
| `SOURCE_AUDIT_HOURS` | `48` | Standalone audit recency window |

Override the thresholds with environment variables; values are validated at
startup. Run a registry-only live audit without an API key using:

```bash
bun run audit:sources > source-health.json
```

The command returns non-zero when coverage or recent-article thresholds fail.
