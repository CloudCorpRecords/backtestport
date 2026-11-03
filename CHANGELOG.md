# Changelog

## 0.1.0 (2026-10-27)

- Initial release: 19 MCP tools and matching CLI subcommands
  for the Backtest360 backtesting engine — engine info, key
  capabilities, catalogs, indicators, templates, strategy
  schema and validation, backtests, latest signals, backtest
  comparison, standalone statistics, ticker search/data and
  macroeconomic series.
- The API key is required (`BACKTEST360_API_KEY`, sent as
  the `X-API-Key` header; engine URL via
  `BACKTEST360_ENGINE_URL`, per-request timeout via
  `BACKTEST360_MCP_TIMEOUT`, output cap via
  `BACKTEST360_MCP_MAX_OUTPUT_BYTES`); upstream JSON is
  returned verbatim, validation results and engine
  rejections are data rather than errors, and rate limits,
  timeouts and upstream failures use the documented error
  strings.
