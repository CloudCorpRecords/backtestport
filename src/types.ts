/**
 * backtestport types.
 *
 * Nineteen tools wrapping the Backtest360 hosted
 * backtesting engine. Every tool answers with the upstream
 * JSON body passed through unchanged (subject to the
 * configured byte cap), as a single string; failures are
 * Errors carrying the pinned error strings. Validation
 * results ({valid: false, ...}) and engine rejections
 * ({accepted: false}) are ordinary upstream bodies, not
 * errors.
 */

export type ResponseDetail = "summary" | "stats" | "full";

export type IncludeSeries =
  | "trades"
  | "equity_curve"
  | "monthly_returns"
  | "yearly_returns"
  | "signal_diagnostics";

/** A strategy document: an object, or a JSON string that parses to one. */
export type StrategyInput = Record<string, unknown> | string;

export interface GetCatalogArgs {
  catalog?: string;
}

export interface ListIndicatorsArgs {
  search?: string;
}

export interface ListTemplatesArgs {
  id?: string;
}

export interface ValidateStrategyArgs {
  strategy: StrategyInput;
}

export interface RunBacktestArgs {
  strategy: StrategyInput;
  symbol?: string;
  start?: string;
  end?: string;
  response_detail?: ResponseDetail;
  max_series_points?: number;
  include?: IncludeSeries[];
  data?: Record<string, unknown>;
}

export interface GetLatestSignalArgs {
  strategy: StrategyInput;
  symbol?: string;
}

export interface CompareBacktestsArgs {
  strategies: StrategyInput[];
  response_detail?: ResponseDetail;
  max_series_points?: number;
  include?: IncludeSeries[];
}

export interface ComputeStatsArgs {
  returns: number[];
}

export interface SearchTickersArgs {
  query: string;
}

export interface SymbolArgs {
  symbol: string;
}

export interface GetPriceHistoryArgs {
  symbol: string;
  start?: string;
  end?: string;
  frequency?: string;
}

export interface GetMacroSeriesArgs {
  series: string;
  start?: string;
  end?: string;
}

/**
 * The minimal slice of a fetch Response this client relies
 * on. Unlike a plain body-only facade, `headers.get` is
 * required so the 429 path can read `Retry-After`.
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Runtime dependencies for the core, all injectable in tests. */
export interface EngineDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /**
   * Environment (BACKTEST360_API_KEY / BACKTEST360_ENGINE_URL /
   * BACKTEST360_MCP_TIMEOUT / BACKTEST360_MCP_MAX_OUTPUT_BYTES).
   * Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
  /** API key override. Defaults to env BACKTEST360_API_KEY. */
  apiKey?: string;
  /** Base URL override. Defaults to env BACKTEST360_ENGINE_URL or the default base. */
  baseUrl?: string;
  /** Per-request timeout override in milliseconds. Defaults to env BACKTEST360_MCP_TIMEOUT (seconds) or 300s. */
  timeoutMs?: number;
  /** Output byte cap override. Defaults to env BACKTEST360_MCP_MAX_OUTPUT_BYTES or 100000. */
  maxOutputBytes?: number;
}
