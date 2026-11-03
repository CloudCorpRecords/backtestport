/**
 * backtestport core: nineteen tools over the Backtest360
 * hosted backtesting engine. This is a backtesting client
 * only — it exposes no live-trading, order or
 * account-mutation tools.
 *
 * Shared rules, as documented in the spec:
 * - The API key is read from env `BACKTEST360_API_KEY` and
 *   is required. It travels as the `X-API-Key` header.
 *   When it is missing, every tool fails with
 *   `BACKTEST360_API_KEY is not set` before any request.
 * - The base URL defaults to `https://api.backtest360.com`
 *   and is overridable via env `BACKTEST360_ENGINE_URL`
 *   (or the injectable deps in tests).
 * - Each request is bounded by a per-request timeout
 *   (env `BACKTEST360_MCP_TIMEOUT`, in seconds, default
 *   300) enforced with an AbortController; expiry fails
 *   with `backtest360 request timed out`.
 * - A successful call returns the upstream JSON body as
 *   text, passed through verbatim subject to the output
 *   byte cap (env `BACKTEST360_MCP_MAX_OUTPUT_BYTES`,
 *   default 100000): a longer body is truncated to the cap
 *   and a line `{"truncated_by_mcp": true}` is appended.
 * - Validation results (`{valid: false, errors: [...]}`)
 *   and engine rejections (`{accepted: false}`) are data:
 *   they return as normal results, never as errors.
 * - HTTP 429 fails with `backtest360 rate limited
 *   (HTTP 429); retry after <value>` when the response
 *   carries a `Retry-After` header (and without the suffix
 *   when it does not). Any other non-2xx fails with
 *   `backtest360 error: HTTP <status>`; a throwing fetch
 *   fails with `backtest360 unreachable`.
 * - `strategy` arguments accept an object or a JSON
 *   string; a string is parsed first and a parse failure
 *   fails with `strategy is not valid JSON`.
 *   `max_series_points`, when given, must be an integer
 *   >= 2, failing with `max_series_points must be an
 *   integer >= 2`. Both validations run before any
 *   request.
 * - Upstream access goes through the injectable fetch in
 *   deps, so tests run against a fake fetch only.
 *
 * Wires (labelled reconstructions): GET `{base}/engine/info`;
 * GET `{base}/me`; GET `{base}/catalogs?catalog=`; GET
 * `{base}/indicators?search=`; GET `{base}/templates` or
 * `{base}/templates/{id}`; GET `{base}/strategy/schema`;
 * POST `{base}/strategy/validate` `{strategy}`; POST
 * `{base}/backtests`; POST `{base}/signals/latest`; POST
 * `{base}/backtests/compare`; POST `{base}/stats`
 * `{returns}`; GET `{base}/tickers/search?q=`; GET
 * `{base}/tickers`; GET `{base}/tickers/{symbol}/data-range`;
 * GET `{base}/tickers/{symbol}`; GET
 * `{base}/tickers/{symbol}/quote`; GET
 * `{base}/tickers/{symbol}/history?start&end&frequency`;
 * GET `{base}/macro`; GET `{base}/macro/{series}?start&end`.
 * Path segments and query values are URL-encoded.
 */
import type {
  CompareBacktestsArgs,
  ComputeStatsArgs,
  EngineDeps,
  FetchFn,
  FetchResponseLike,
  GetCatalogArgs,
  GetLatestSignalArgs,
  GetMacroSeriesArgs,
  GetPriceHistoryArgs,
  ListIndicatorsArgs,
  ListTemplatesArgs,
  RunBacktestArgs,
  SearchTickersArgs,
  SymbolArgs,
  ValidateStrategyArgs,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_BASE_URL = "https://api.backtest360.com";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_OUTPUT_BYTES = 100000;
const TRUNCATION_MARKER = '{"truncated_by_mcp": true}';

function envOf(deps: EngineDeps): Record<string, string | undefined> {
  return deps.env ?? process.env;
}

function baseUrl(deps: EngineDeps): string {
  if (deps.baseUrl && deps.baseUrl.trim() !== "") {
    return deps.baseUrl.trim().replace(/\/+$/, "");
  }
  const raw = envOf(deps).BACKTEST360_ENGINE_URL;
  const base = raw && raw.trim() !== "" ? raw.trim() : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

/** The configured API key; every tool fails before any request without one. */
function requireApiKey(deps: EngineDeps): string {
  const key = deps.apiKey ?? envOf(deps).BACKTEST360_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error("BACKTEST360_API_KEY is not set");
  }
  return key;
}

function timeoutMs(deps: EngineDeps): number {
  if (deps.timeoutMs !== undefined && Number.isFinite(deps.timeoutMs) && deps.timeoutMs >= 0) {
    return deps.timeoutMs;
  }
  const raw = envOf(deps).BACKTEST360_MCP_TIMEOUT;
  const seconds = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return DEFAULT_TIMEOUT_SECONDS * 1000;
}

function maxOutputBytes(deps: EngineDeps): number {
  if (
    deps.maxOutputBytes !== undefined &&
    Number.isFinite(deps.maxOutputBytes) &&
    deps.maxOutputBytes >= 0
  ) {
    return Math.floor(deps.maxOutputBytes);
  }
  const raw = envOf(deps).BACKTEST360_MCP_MAX_OUTPUT_BYTES;
  const parsed = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return DEFAULT_MAX_OUTPUT_BYTES;
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init);
}

function fetchFn(deps: EngineDeps): FetchFn {
  return deps.fetchFn ?? defaultFetch;
}

/** Truncate an over-cap body to the cap (in bytes) and append the marker line. */
function applyByteCap(text: string, cap: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return text;
  const truncated = bytes.subarray(0, cap).toString("utf8");
  return truncated + (truncated.endsWith("\n") ? "" : "\n") + TRUNCATION_MARKER;
}

/**
 * Run one request against the engine and return the body
 * text verbatim (subject to the byte cap). The API key is
 * required and is checked here, before any request is made.
 */
async function callApi(
  deps: EngineDeps,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<string> {
  const key = requireApiKey(deps);
  const base = baseUrl(deps);
  const headers: Record<string, string> = { "X-API-Key": key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(deps));
  (timer as unknown as { unref?: () => void }).unref?.();
  let res: FetchResponseLike;
  try {
    res = await fetchFn(deps)(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (
      controller.signal.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw new Error("backtest360 request timed out");
    }
    throw new Error("backtest360 unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    const retryAfter =
      res.headers?.get("Retry-After") ?? res.headers?.get("retry-after");
    if (retryAfter) {
      throw new Error(`backtest360 rate limited (HTTP 429); retry after ${retryAfter}`);
    }
    throw new Error("backtest360 rate limited (HTTP 429)");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`backtest360 error: HTTP ${res.status}`);
  }
  return applyByteCap(await res.text(), maxOutputBytes(deps));
}

/* ------------------------------------------------------------------ */
/* Argument validation / normalisation                                 */
/* ------------------------------------------------------------------ */

/**
 * Normalise a strategy argument: an object passes through;
 * a JSON string is parsed first (parse failure is the
 * pinned error). Used for `strategy` and for each item of
 * `strategies`.
 */
function parseStrategy(value: unknown): unknown {
  if (value === undefined || value === null) {
    throw new Error("strategy is required");
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error("strategy is not valid JSON");
    }
  }
  if (typeof value === "object") return value;
  throw new Error("strategy must be an object or a JSON string");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function validateMaxSeriesPoints(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
    throw new Error("max_series_points must be an integer >= 2");
  }
  return value;
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(name, value);
  }
  const qs = search.toString();
  return qs === "" ? "" : `?${qs}`;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** Engine version, API contract, health. Wire: GET {base}/engine/info. */
export async function engineInfo(
  _args: Record<string, never> = {},
  deps: EngineDeps = {},
): Promise<string> {
  return callApi(deps, "GET", "/engine/info");
}

/** What the configured key can do. Wire: GET {base}/me. */
export async function getMe(
  _args: Record<string, never> = {},
  deps: EngineDeps = {},
): Promise<string> {
  return callApi(deps, "GET", "/me");
}

/** Reference catalogs. Wire: GET {base}/catalogs?catalog=. */
export async function getCatalog(
  args: GetCatalogArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const catalog = optionalString(a.catalog, "catalog");
  return callApi(deps, "GET", `/catalogs${queryString({ catalog })}`);
}

/** Indicator discovery. Wire: GET {base}/indicators?search=. */
export async function listIndicators(
  args: ListIndicatorsArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const search = optionalString(a.search, "search");
  return callApi(deps, "GET", `/indicators${queryString({ search })}`);
}

/** Strategy templates. Wire: GET {base}/templates or {base}/templates/{id}. */
export async function listTemplates(
  args: ListTemplatesArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const id = optionalString(a.id, "id");
  const path = id ? `/templates/${encodeURIComponent(id)}` : "/templates";
  return callApi(deps, "GET", path);
}

/** JSON Schema for strategy documents. Wire: GET {base}/strategy/schema. */
export async function getStrategySchema(
  _args: Record<string, never> = {},
  deps: EngineDeps = {},
): Promise<string> {
  return callApi(deps, "GET", "/strategy/schema");
}

/**
 * Validate a strategy without running it. A `{valid: false}`
 * body is a normal result.
 * Wire: POST {base}/strategy/validate {strategy}.
 */
export async function validateStrategy(
  args: ValidateStrategyArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const strategy = parseStrategy(a.strategy);
  return callApi(deps, "POST", "/strategy/validate", { strategy });
}

/**
 * Run a backtest. An `{accepted: false}` body is a normal
 * result. Wire: POST {base}/backtests.
 */
export async function runBacktest(
  args: RunBacktestArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const strategy = parseStrategy(a.strategy);
  const maxSeriesPoints = validateMaxSeriesPoints(a.max_series_points);
  const body: Record<string, unknown> = { strategy };
  const symbol = optionalString(a.symbol, "symbol");
  if (symbol !== undefined) body.symbol = symbol;
  const start = optionalString(a.start, "start");
  if (start !== undefined) body.start = start;
  const end = optionalString(a.end, "end");
  if (end !== undefined) body.end = end;
  const responseDetail = optionalString(a.response_detail, "response_detail");
  if (responseDetail !== undefined) body.response_detail = responseDetail;
  if (maxSeriesPoints !== undefined) body.max_series_points = maxSeriesPoints;
  if (a.include !== undefined && a.include !== null) {
    if (!Array.isArray(a.include)) throw new Error("include must be an array");
    body.include = a.include;
  }
  if (a.data !== undefined && a.data !== null) {
    if (typeof a.data !== "object" || Array.isArray(a.data)) {
      throw new Error("data must be an object");
    }
    body.data = a.data;
  }
  return callApi(deps, "POST", "/backtests", body);
}

/** Evaluate the most recent bar only. Wire: POST {base}/signals/latest. */
export async function getLatestSignal(
  args: GetLatestSignalArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const strategy = parseStrategy(a.strategy);
  const body: Record<string, unknown> = { strategy };
  const symbol = optionalString(a.symbol, "symbol");
  if (symbol !== undefined) body.symbol = symbol;
  return callApi(deps, "POST", "/signals/latest", body);
}

/**
 * Run several strategies on the same data, side by side.
 * Wire: POST {base}/backtests/compare.
 */
export async function compareBacktests(
  args: CompareBacktestsArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  if (!Array.isArray(a.strategies) || a.strategies.length === 0) {
    throw new Error("strategies must be a non-empty array");
  }
  const strategies = a.strategies.map((item) => parseStrategy(item));
  const maxSeriesPoints = validateMaxSeriesPoints(a.max_series_points);
  const body: Record<string, unknown> = { strategies };
  const responseDetail = optionalString(a.response_detail, "response_detail");
  if (responseDetail !== undefined) body.response_detail = responseDetail;
  if (maxSeriesPoints !== undefined) body.max_series_points = maxSeriesPoints;
  if (a.include !== undefined && a.include !== null) {
    if (!Array.isArray(a.include)) throw new Error("include must be an array");
    body.include = a.include;
  }
  return callApi(deps, "POST", "/backtests/compare", body);
}

/**
 * Compute the metric set from an externally produced
 * returns series. Wire: POST {base}/stats {returns}.
 */
export async function computeStats(
  args: ComputeStatsArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  if (
    !Array.isArray(a.returns) ||
    !a.returns.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new Error("returns must be an array of numbers");
  }
  return callApi(deps, "POST", "/stats", { returns: a.returns });
}

/** Search the fetchable symbol universe. Wire: GET {base}/tickers/search?q=. */
export async function searchTickers(
  args: SearchTickersArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const query = requireString(a.query, "query");
  return callApi(deps, "GET", `/tickers/search${queryString({ q: query })}`);
}

/** List the fetchable symbol universe. Wire: GET {base}/tickers. */
export async function listTickers(
  _args: Record<string, never> = {},
  deps: EngineDeps = {},
): Promise<string> {
  return callApi(deps, "GET", "/tickers");
}

/** Available history for a symbol. Wire: GET {base}/tickers/{symbol}/data-range. */
export async function getDataRange(
  args: SymbolArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const symbol = requireString(a.symbol, "symbol");
  return callApi(deps, "GET", `/tickers/${encodeURIComponent(symbol)}/data-range`);
}

/** Symbol identity and data coverage. Wire: GET {base}/tickers/{symbol}. */
export async function getTickerInfo(
  args: SymbolArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const symbol = requireString(a.symbol, "symbol");
  return callApi(deps, "GET", `/tickers/${encodeURIComponent(symbol)}`);
}

/** Latest available price for a symbol. Wire: GET {base}/tickers/{symbol}/quote. */
export async function getQuote(
  args: SymbolArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const symbol = requireString(a.symbol, "symbol");
  return callApi(deps, "GET", `/tickers/${encodeURIComponent(symbol)}/quote`);
}

/**
 * OHLCV price history over a date range.
 * Wire: GET {base}/tickers/{symbol}/history?start&end&frequency.
 */
export async function getPriceHistory(
  args: GetPriceHistoryArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const symbol = requireString(a.symbol, "symbol");
  const start = optionalString(a.start, "start");
  const end = optionalString(a.end, "end");
  const frequency = optionalString(a.frequency, "frequency");
  return callApi(
    deps,
    "GET",
    `/tickers/${encodeURIComponent(symbol)}/history${queryString({ start, end, frequency })}`,
  );
}

/** List the macroeconomic series catalog. Wire: GET {base}/macro. */
export async function listMacroSeries(
  _args: Record<string, never> = {},
  deps: EngineDeps = {},
): Promise<string> {
  return callApi(deps, "GET", "/macro");
}

/** Fetch one macro series' observations. Wire: GET {base}/macro/{series}?start&end. */
export async function getMacroSeries(
  args: GetMacroSeriesArgs,
  deps: EngineDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const series = requireString(a.series, "series");
  const start = optionalString(a.start, "start");
  const end = optionalString(a.end, "end");
  return callApi(
    deps,
    "GET",
    `/macro/${encodeURIComponent(series)}${queryString({ start, end })}`,
  );
}
