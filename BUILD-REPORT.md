# backtestport — Build Report (Batch 24)

Rebuild of the `com.backtest360/backtest360` MCP server
(PyPI package `backtest360-mcp`) from the firsthand spec
in `specs-batch24/backtestport.md`. Built 2026-10-27.

## Identity

- npm: `@reneturcios/backtestport` @ 0.1.0, bin
  `backtestport` → `dist/cli.js`
- MCP Registry name: `io.github.CloudCorpRecords/backtestport`
  (matches `package.json` `mcpName`, `server.json` `name`,
  and the Dockerfile `io.modelcontextprotocol.server.name`
  label)
- server.json description (95 chars, verified):
  "Backtesting engine client: indicators, strategy
  validation, backtests, signals and market data."
- server.json: npm package entry carries `"version":
  "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/backtestport:0.1.0`) carries
  **no** `version` field (verified).

## Files (19-file factory set, per TEMPLATE.md §2)

package.json, server.json, Dockerfile, tsconfig.json
(copied unchanged from the factory reference),
.dockerignore, .gitignore, package-lock.json, README.md
(fresh prose), LICENSE (MIT, © 2026 Rene Turcios),
CHANGELOG.md (single 0.1.0 entry dated 2026-10-27),
src/index.ts, src/cli.ts, src/mcp.ts, src/types.ts,
src/engine.ts (core), test/engine.test.ts, and the four
workflows under .github/workflows/ (publish-container
adapted: IMAGE ghcr.io/cloudcorprecords/backtestport,
smoke assertion on server name `backtestport`). Plus this
BUILD-REPORT.md and the parity-out/ artifacts. The parity
fixture lives at
`harness/fixtures/backtest360-mcp-tools-original.json`
with the spec's exact `_source` string (byte-compared
against the spec file after writing).

## Implementation

- `src/mcp.ts`: low-level `Server` API
  (`sdk/server/index.js` + `StdioServerTransport`,
  handlers for `ListToolsRequestSchema` /
  `CallToolRequestSchema` from `sdk/types.js`), explicit
  JSON-schema literals for all 19 tools; no McpServer/zod
  registration. In the schemas, `strategy` (and each
  `strategies` item) is typed `{"type": ["object",
  "string"]}`, `include` is an array whose items enum the
  five pinned values (`trades`, `equity_curve`,
  `monthly_returns`, `yearly_returns`,
  `signal_diagnostics`), `response_detail` enums
  `summary`/`stats`/`full`, and `max_series_points` is an
  integer with `minimum: 2`.
- `src/engine.ts`: `VERSION = "0.1.0"`. All upstream
  access goes through an injectable fetch (deps `fetchFn`,
  `env`, `apiKey`, `baseUrl`, `timeoutMs`,
  `maxOutputBytes`). The fetch facade's response type
  exposes `headers.get(name)` (an extension of the
  factory's body-only facade) so the 429 path can read
  `Retry-After`, and its init carries the AbortController
  `signal` for the timeout.
- Configuration: `BACKTEST360_API_KEY` is required and is
  sent as the `X-API-Key` header; a missing or empty key
  fails every tool with `BACKTEST360_API_KEY is not set`
  before any request. Base URL defaults to
  `https://api.backtest360.com`, overridable via
  `BACKTEST360_ENGINE_URL`. `BACKTEST360_MCP_TIMEOUT`
  (seconds, default 300) bounds each request via an
  AbortController; expiry fails with `backtest360 request
  timed out`. `BACKTEST360_MCP_MAX_OUTPUT_BYTES` (default
  100000) caps response bodies: a longer body is
  truncated to the cap in bytes and a line
  `{"truncated_by_mcp": true}` is appended.
- Semantics: success returns the upstream body verbatim
  (subject to the byte cap). Validation results
  (`{valid: false, errors: [...]}`) and engine rejections
  (`{accepted: false}`) return as NORMAL results, never
  isError. HTTP 429 fails with `backtest360 rate limited
  (HTTP 429); retry after <value>` when a `Retry-After`
  header is present; any other non-2xx fails with
  `backtest360 error: HTTP <status>`; a throwing fetch
  fails with `backtest360 unreachable`.
- Local validation, before any request: a `strategy`
  given as a JSON string is parsed first (parse failure →
  `strategy is not valid JSON`); `max_series_points` must
  be an integer >= 2 (`max_series_points must be an
  integer >= 2`); `strategies` must be a non-empty array
  whose items normalise like `strategy`; `returns` must
  be an array of finite numbers. Optional fields are
  forwarded only when given — no defaults are synthesised
  client-side (the `summary` / 500 defaults are the
  engine's, per the spec's optional wire fields).
- CLI: one subcommand per tool (all 19) taking a JSON
  argument string, `mcp`, `--version` (prints `0.1.0`);
  unknown subcommand → usage on stderr, exit 2; isError
  results exit 1.
- This is a backtesting client only: no live-trading,
  order or account-mutation tool exists in the surface.

## Endpoint provenance (pinned vs reconstructed)

README-pinned:

- The 19 tools and their descriptions; the
  `response_detail` / `max_series_points` / `include`
  semantics; the four `BACKTEST360_*` environment
  variables with defaults; `X-API-Key` auth; the error
  semantics (`{valid: false}` / `{accepted: false}` are
  data).

Labelled reconstructions (also labelled in README.md and
in the spec): per-tool argument names beyond the README
table, and all wire paths — GET `{base}/engine/info`;
GET `{base}/me`; GET `{base}/catalogs?catalog=`; GET
`{base}/indicators?search=`; GET `{base}/templates` or
`{base}/templates/{id}`; GET `{base}/strategy/schema`;
POST `{base}/strategy/validate` `{strategy}`; POST
`{base}/backtests`; POST `{base}/signals/latest`; POST
`{base}/backtests/compare`; POST `{base}/stats`
`{returns}`; GET `{base}/tickers/search?q=`; GET
`{base}/tickers`; GET `{base}/tickers/{symbol}/data-range`;
GET `{base}/tickers/{symbol}`; GET
`{base}/tickers/{symbol}/quote`; GET
`{base}/tickers/{symbol}/history?start&end&frequency`;
GET `{base}/macro`; GET `{base}/macro/{series}?start&end`.
Path segments and query values are URL-encoded.

## Verification (all real, run 2026-10-27)

- `npm run build` (tsc): exit 0. Fresh `npx tsc --noEmit`:
  exit 0.
- `npm test`: **44 tests, 44 pass, 0 fail** — fake fetch
  and injected env only, no live network (the CLI tests
  spawn the CLI through tsx and exercise only paths that
  fail before any request). Covers: the missing-key error
  (no request made, incl. the empty-string key); wire
  paths for engine info, me, catalogs (with and without
  the filter), templates (list and encoded id), ticker
  search/info (encoding), price history query forwarding
  and macro series; the `X-API-Key` header and env
  base-URL handling; strategy as an object and as a JSON
  string (parsed before sending), bad JSON →
  `strategy is not valid JSON` with no request, missing
  strategy, compare-item normalisation and its failures;
  full and minimal `run_backtest` bodies;
  `max_series_points` at 1 / 2.5 / 0 rejected with the
  pinned string and 2 accepted; `compute_stats`
  validation; `{valid: false}` and `{accepted: false}`
  bodies returned verbatim as NORMAL results; a raw
  non-canonical JSON body passed through untouched; the
  byte cap (over-cap truncation with the exact marker
  line, at-cap body untouched, cap read from env); 429
  with `Retry-After` (pinned message with the value) and
  without (no suffix); 500/404 → `backtest360 error:
  HTTP <status>`; a throwing fetch → `backtest360
  unreachable`; timeout via a signal-driven aborting fake
  fetch and via an `AbortError`-throwing fake, both →
  `backtest360 request timed out`; and the CLI cases
  (`--version` exit 0, unknown subcommand / non-JSON
  argument exit 2, missing key / `max_series_points` /
  bad-JSON exits 1).
- `node dist/cli.js --version`: prints `0.1.0`. Unknown
  subcommand exits 2 with usage; a missing key exits 1
  with `BACKTEST360_API_KEY is not set` (both spot-checked
  against the built CLI).
- Parity: tools captured by sending initialize +
  tools/list to `node dist/cli.js mcp` over stdio into
  `parity-out/tools-rebuild.json` (serverInfo name
  `backtestport`, version `0.1.0`, 19 tools), then
  `harness/parity.py` against
  `harness/fixtures/backtest360-mcp-tools-original.json`
  → **PASS, parity 100.0, identical_tools 19 / total 19**
  (see `parity-out/parity.json`).
- Lockfile (Route 3, clean from birth): generated in a
  temp dir containing only `package.json` with
  `npm install --package-lock-only --ignore-scripts
  --offline`; verified it parses, `name` ==
  `@reneturcios/backtestport`, **128 package entries**;
  copied in as `package-lock.json`, then
  `npm install --offline` in the build dir succeeded.
- Version consistency: `package.json` 0.1.0 =
  `server.json` top-level 0.1.0 = npm entry 0.1.0 = OCI
  tag `:0.1.0` = core `VERSION` 0.1.0 = CHANGELOG heading
  `## 0.1.0 (2026-10-27)`.

## Gaps

- Live upstream behaviour is unproven: no live call was
  made (tests are fake-fetch only, and no API key was
  available or used).
- All wire paths and per-tool argument names beyond the
  README table are labelled reconstructions, per the
  spec.
- Rendering choice where the spec leaves the no-header
  case open: HTTP 429 without a `Retry-After` header
  renders as `backtest360 rate limited (HTTP 429)` with no
  suffix.
- Local error strings not pinned by the spec (ours):
  `strategy is required`, `strategy must be an object or
  a JSON string`, `strategies must be a non-empty array`,
  `returns must be an array of numbers`, `<name> is
  required` / `<name> must be a string` for the simple
  string arguments, `include must be an array`, `data
  must be an object`. The spec-pinned strings
  (`BACKTEST360_API_KEY is not set`, `strategy is not
  valid JSON`, `max_series_points must be an integer
  >= 2`, and the rate-limit / timeout / HTTP /
  unreachable family) are used verbatim.
- `response_detail` and `include` enum membership is
  enforced by the MCP input schemas; the core forwards
  values without a second local enum check, so a bad enum
  sent via the CLI reaches the engine, whose rejection
  body is data per the pinned semantics.
