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
- `origin/main` is the sole production/default branch.
- `origin/v2` is the long-lived integration branch for reviewed V2 changes.
- Delivery work branches from a frozen `origin/v2` commit and returns through a
  reviewed pull request. Reviewed `v2` trees are promoted to `main` through a
  separate, pure promotion pull request; delivery agents do not merge either PR.

The initial V2 base is
`9f9f5cecdd76cb33087400ffd8004489801b6250`. To sync upstream, first fetch both
remotes, integrate the selected upstream range into `v2` through a dedicated
reviewed branch, then promote the unchanged reviewed tree into `main`. Never
force-push V2 customization onto either protected branch.

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

## Scheduled delivery

`.github/workflows/digest.yml` contains one shared production DAG for the daily
`0 0 * * *` schedule (08:00 in Asia/Shanghai) and manual dispatches. Scheduled
runs are skipped unless the repository variable `PRODUCTION_ENABLED` is exactly
`true`; manual dispatch remains available while it is `false` for controlled
post-merge acceptance.

All provider location, model, API style, and endpoint paths come from repository
variables, so the workflow supports third-party OpenAI-compatible endpoints and
does not require the official OpenAI host or a Gemini key. Credential values
remain GitHub Secrets. A preflight step validates every required name before
source fetching or model calls.

Model calls make at most five attempts. Standard transient HTTP responses
(`408`, `409`, `429`, and `5xx`) are retried, as are narrowly recognized relay
`400` responses whose body identifies an upstream outage or a temporarily
suspended shared account pool. Ordinary invalid requests remain fail-fast.
Retries use 5, 10, 20, and 40 second backoffs. If digest generation still fails,
the workflow remains failed and sends a red Feishu card linked to that Actions
run; it does not create an archive, Docx, or success card. Recovery is a manual
workflow dispatch after the provider is healthy.

After strict digest validation produces a dated Markdown report and updates
`docs/feed.xml`, the DAG pushes those public repository archives to Git before
invoking the pinned official
`@larksuite/cli@1.0.86` with bot identity. The publisher enumerates the dedicated
folder directly, exactly matches `AI Daily Digest · YYYY-MM-DD` using the
Asia/Shanghai date, and creates or updates one Docx. It restores the canonical
title after either write, re-enumerates the folder, and requires exactly one
matching Docx with the token just written. Multiple exact matches, title-restore
failures, and post-write verification failures fail closed.

Only the zero-match path that creates the day's canonical Docx sends the linked
interactive card. A same-day one-match update never calls the card API, even if
the rerun occurs after Feishu's one-hour `uuid` deduplication window. The stable
`ai-digest-YYYY-MM-DD` key remains a short-window defense in depth, while the
Docx create/update decision provides full-day at-most-once behavior. This has a
deliberate fail-closed trade-off: if the first card send fails after the Docx was
created, automatic same-day reruns update the Docx but do not resend the card;
an operator must recover that missing notification manually. The production
workflow step retains its historical "then send" label, but card delivery is
conditional: update runs stop after the verified Docx write.

### Manual recovery after an initial card failure

Treat a failed send as ambiguous because Feishu may have accepted the card even
when the CLI returned an error. Keep `PRODUCTION_ENABLED=false`, do not rerun the
daily workflow to recover the notification, and use this operator procedure:

1. Directly enumerate `FEISHU_FOLDER_TOKEN` with the pinned
   `@larksuite/cli@1.0.86` production bot profile. Require exactly one canonical
   `AI Daily Digest · YYYY-MM-DD` Docx and record its URL/token. Stop on zero,
   multiple, or mismatched results.
2. With an explicitly authorized read-only user identity, read the destination
   chat's complete message history for that Beijing date. If the canonical card
   already exists, recovery is complete. If history cannot be read completely,
   fail closed instead of sending.
3. Only after absence is proven, obtain a separate production-operation
   approval and send one card with the configured bot/recipient, the canonical
   Docx URL, the `buildDigestCard` payload, and
   `--idempotency-key ai-digest-YYYY-MM-DD` through the pinned CLI. Reusing the
   date key is only short-window defense in depth; the history check is the
   manual recovery guard.
4. If that one-off send returns an ambiguous failure, never retry blindly.
   Repeat the complete history check first, then record the Docx URL/token,
   message ID, approval, and outcome without credential values.

This is intentionally an operator runbook, not an automatic retry, outbox,
database, card-update workflow, or production bot-history dependency.

The production DAG does not generate new HTML, deploy GitHub Pages, or create
daily GitHub Releases. Historical HTML and the legacy conversion helper remain
in the repository as inherited artifacts but are not part of production.
