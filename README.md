# backtestport

Backtest a trading strategy without standing up your own
engine. backtestport is a small client for the Backtest360
hosted backtesting engine: you hand it a strategy document
and it validates the document, runs the backtest, evaluates
the latest signal, compares several strategies on the same
data, and fetches the market and macroeconomic data the
engine can work with — plus the indicator catalog,
templates and reference data you need to write the strategy
in the first place.

This is a backtesting client only. It has no live-trading,
order-placement or account tools, and nothing it does moves
money.

Responses come back exactly as the engine returned them:
nothing is trimmed, renamed or summarised on the way
through, apart from the output byte cap described below.

## Configuration

Four environment variables control the client:

- `BACKTEST360_API_KEY` (required) — sent on every request
  as the `X-API-Key` header. When it is not set, every tool
  fails with `BACKTEST360_API_KEY is not set` before any
  request is made.
- `BACKTEST360_ENGINE_URL` (optional) — engine base URL.
  Defaults to `https://api.backtest360.com`.
- `BACKTEST360_MCP_TIMEOUT` (optional) — per-request
  timeout in seconds, default `300`. A request that runs
  past it fails with `backtest360 request timed out`.
- `BACKTEST360_MCP_MAX_OUTPUT_BYTES` (optional) — response
  size cap in bytes, default `100000`. A longer body is
  truncated to the cap and a final line
  `{"truncated_by_mcp": true}` is appended, so a huge equity
  curve cannot flood the caller.

## Reading the results

Two engine answers that look like failures are not:

- Strategy validation returns `{valid: false, errors: [...]}`
  when the document has problems. That is a normal result —
  the errors are structured and locatable so you can fix
  the document.
- A backtest the engine declines returns
  `{accepted: false}`. That is also a normal result.

Actual failures are errors: HTTP 429 fails with
`backtest360 rate limited (HTTP 429); retry after <value>`
when the engine sends a `Retry-After` header (without the
suffix when it does not), any other non-2xx reply fails
with `backtest360 error: HTTP <status>`, and an unreachable
engine fails with `backtest360 unreachable`.

Strategy arguments (`strategy`, and each item of
`strategies`) accept either a JSON object or a JSON string,
which is parsed before sending; a string that does not
parse fails with `strategy is not valid JSON`.

Three arguments shape a backtest run:

- `response_detail` — `summary` (default), `stats` or
  `full`: how much of the verdict comes back.
- `max_series_points` — cap on returned series length,
  default 500; it must be an integer of at least 2, checked
  locally before any request
  (`max_series_points must be an integer >= 2`).
- `include` — any of `trades`, `equity_curve`,
  `monthly_returns`, `yearly_returns` and
  `signal_diagnostics`, each adding its series to the
  verdict.

## Tools

Discovery and account:

- `engine_info` — engine version, API contract, health.
- `get_me` — what the configured key can do: permission
  scopes, limits, current usage, capability flags.
- `get_catalog` — the reference catalogs (operators,
  execution modes, stop types, sizing methods, bar
  frequencies, metric sections); pass `catalog` to fetch
  just one.
- `list_indicators` — indicator discovery with
  per-indicator parameter schemas; `search` narrows the
  list.
- `list_templates` — predesigned strategy templates,
  listed compactly, or one in full when `id` is given.
- `get_strategy_schema` — the JSON Schema for strategy
  documents.

Strategies and runs:

- `validate_strategy` — check a strategy document without
  running it.
- `run_backtest` — run a backtest; `symbol`, `start`,
  `end`, the shaping arguments above, and `data` (inline
  bars as an object) are all optional.
- `get_latest_signal` — evaluate the most recent bar only;
  no P&L.
- `compare_backtests` — run several strategies on the same
  data, side by side.
- `compute_stats` — compute the metric set from an
  externally produced `returns` series.

Market and macro data:

- `search_tickers` / `list_tickers` — the fetchable symbol
  universe.
- `get_data_range` — available history and a bar-count
  estimate for a symbol.
- `get_ticker_info` — symbol identity and data coverage in
  a single call.
- `get_quote` — latest available price for a symbol.
- `get_price_history` — OHLCV history over a date range
  (`start`, `end`, `frequency`; with server-side data the
  engine fixes bars at 1d — the argument is accepted and
  forwarded).
- `list_macro_series` / `get_macro_series` — the
  macroeconomic series catalog, and one series'
  observations over an optional date range.

### Endpoint provenance

The original project's README pins the 19 tools, the
shaping-argument semantics, the four environment variables
with their defaults, the `X-API-Key` header and the rule
that validation results and engine rejections are data.
The wire paths below are reconstructions, labelled as
such: `GET /engine/info`, `GET /me`, `GET /catalogs`,
`GET /indicators`, `GET /templates[/{id}]`,
`GET /strategy/schema`, `POST /strategy/validate`,
`POST /backtests`, `POST /signals/latest`,
`POST /backtests/compare`, `POST /stats`,
`GET /tickers/search`, `GET /tickers`,
`GET /tickers/{symbol}/data-range`, `GET /tickers/{symbol}`,
`GET /tickers/{symbol}/quote`,
`GET /tickers/{symbol}/history`, `GET /macro`,
`GET /macro/{series}` — all under the configured base URL,
with path segments and query values URL-encoded.

## CLI

Each tool is a subcommand taking one JSON argument string:

```bash
npx @reneturcios/backtestport engine_info '{}'
npx @reneturcios/backtestport validate_strategy '{"strategy":{"name":"sma-cross","rules":[]}}'
npx @reneturcios/backtestport run_backtest '{"strategy":{"name":"sma-cross"},"symbol":"AAPL","include":["equity_curve"]}'
npx @reneturcios/backtestport get_quote '{"symbol":"AAPL"}'
npx @reneturcios/backtestport --version
```

Output is the tool's result text (the upstream JSON on
success). Exit codes: `0` on success, `1` on a runtime
error (including a missing key, a validation failure or an
upstream failure), `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/backtestport mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "backtestport": {
      "command": "npx",
      "args": ["-y", "@reneturcios/backtestport", "mcp"],
      "env": {
        "BACKTEST360_API_KEY": "<your key>"
      }
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/backtestport
docker run --rm ghcr.io/cloudcorprecords/backtestport get_quote '{"symbol":"AAPL"}'
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (fake fetch only, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios
