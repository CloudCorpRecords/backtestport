/**
 * backtestport MCP server. Tools: engine_info, get_me,
 * get_catalog, list_indicators, list_templates,
 * get_strategy_schema, validate_strategy, run_backtest,
 * get_latest_signal, compare_backtests, compute_stats,
 * search_tickers, list_tickers, get_data_range,
 * get_ticker_info, get_quote, get_price_history,
 * list_macro_series, get_macro_series.
 *
 * Why the low-level Server instead of McpServer: the
 * high-level helper converts zod schemas to JSON Schema and
 * injects keys that are not in this tool set's documented
 * spec ("$schema" and "additionalProperties"), which breaks
 * exact tool-list/schema parity with the spec. This file
 * serves tools/list with the spec's exact input schemas as
 * explicit literals, and the core validates every tools/call
 * argument set itself.
 *
 * Every tool returns a single text item carrying the upstream
 * JSON verbatim (subject to the byte cap); validation results
 * and engine rejections are normal results, while key,
 * validation, rate-limit, timeout and upstream failures come
 * back as isError results carrying the documented error
 * strings.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  compareBacktests,
  computeStats,
  engineInfo,
  getCatalog,
  getDataRange,
  getLatestSignal,
  getMacroSeries,
  getMe,
  getPriceHistory,
  getQuote,
  getStrategySchema,
  getTickerInfo,
  listIndicators,
  listMacroSeries,
  listTemplates,
  listTickers,
  runBacktest,
  searchTickers,
  validateStrategy,
  VERSION,
} from "./engine.js";

const INCLUDE_SCHEMA = {
  items: {
    enum: [
      "trades",
      "equity_curve",
      "monthly_returns",
      "yearly_returns",
      "signal_diagnostics",
    ],
    type: "string" as const,
  },
  type: "array" as const,
  description: "Sections to include in the response (optional).",
};

const RESPONSE_DETAIL_SCHEMA = {
  enum: ["summary", "stats", "full"],
  type: "string" as const,
  description: "Level of detail for the response (optional).",
};

const MAX_SERIES_POINTS_SCHEMA = { minimum: 2, type: "integer" as const, description: "Maximum number of series points to return (optional)." };

const STRATEGY_SCHEMA = { type: ["object", "string"] as const, description: "Strategy definition, as an object or a JSON string." };

const TOOLS = [
  {
    name: "engine_info",
    description: "Engine version, API contract, health.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_me",
    description:
      "What the configured key can do: permission scopes, limits, current usage, capability flags.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_catalog",
    description:
      "Reference catalogs: operators, execution modes, stop types, sizing methods, bar frequencies, metric sections.",
    inputSchema: {
      type: "object" as const,
      properties: { catalog: { type: "string" , description: "Catalog name to retrieve." } },
    },
  },
  {
    name: "list_indicators",
    description: "Indicator discovery; per-indicator parameter schemas.",
    inputSchema: {
      type: "object" as const,
      properties: { search: { type: "string" , description: "Search text filter (optional)." } },
    },
  },
  {
    name: "list_templates",
    description:
      "Predesigned strategy templates — discover compactly, fetch one in full, ready to validate and run.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string" , description: "Identifier of the record to operate on." } },
    },
  },
  {
    name: "get_strategy_schema",
    description: "JSON Schema for strategy documents.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "validate_strategy",
    description:
      "Validate a strategy without running it — returns structured, locatable errors.",
    inputSchema: {
      type: "object" as const,
      properties: { strategy: STRATEGY_SCHEMA },
      required: ["strategy"],
    },
  },
  {
    name: "run_backtest",
    description: "Run a backtest of a strategy over historical data for the given symbol and date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        data: { type: "object" , description: "Data payload for this call." },
        end: { type: "string" , description: "End date for the range (ISO 8601)." },
        include: INCLUDE_SCHEMA,
        max_series_points: MAX_SERIES_POINTS_SCHEMA,
        response_detail: RESPONSE_DETAIL_SCHEMA,
        start: { type: "string" , description: "Start date for the range (ISO 8601)." },
        strategy: STRATEGY_SCHEMA,
        symbol: { type: "string" , description: "Ticker symbol, e.g. AAPL." },
      },
      required: ["strategy"],
    },
  },
  {
    name: "get_latest_signal",
    description: "Evaluate the most recent bar only (no P&L).",
    inputSchema: {
      type: "object" as const,
      properties: {
        strategy: STRATEGY_SCHEMA,
        symbol: { type: "string" , description: "Ticker symbol, e.g. AAPL." },
      },
      required: ["strategy"],
    },
  },
  {
    name: "compare_backtests",
    description: "Run several strategies on the same data, side by side.",
    inputSchema: {
      type: "object" as const,
      properties: {
        include: INCLUDE_SCHEMA,
        max_series_points: MAX_SERIES_POINTS_SCHEMA,
        response_detail: RESPONSE_DETAIL_SCHEMA,
        strategies: {
          items: { type: ["object", "string"] as const },
          minItems: 1,
          type: "array" as const,
         description: "Strategy definitions or identifiers to compare." },
      },
      required: ["strategies"],
    },
  },
  {
    name: "compute_stats",
    description:
      "Compute the metric set from an externally produced returns series.",
    inputSchema: {
      type: "object" as const,
      properties: {
        returns: { items: { type: "number" }, type: "array" , description: "Series of returns values." },
      },
      required: ["returns"],
    },
  },
  {
    name: "search_tickers",
    description: "Search the fetchable symbol universe.",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" , description: "Search query text." } },
      required: ["query"],
    },
  },
  {
    name: "list_tickers",
    description: "List the fetchable symbol universe.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_data_range",
    description: "Available history and bar-count estimate for a symbol.",
    inputSchema: {
      type: "object" as const,
      properties: { symbol: { type: "string" , description: "Ticker symbol, e.g. AAPL." } },
      required: ["symbol"],
    },
  },
  {
    name: "get_ticker_info",
    description: "Symbol identity and data coverage in a single call.",
    inputSchema: {
      type: "object" as const,
      properties: { symbol: { type: "string" , description: "Ticker symbol, e.g. AAPL." } },
      required: ["symbol"],
    },
  },
  {
    name: "get_quote",
    description: "Latest available price for a symbol.",
    inputSchema: {
      type: "object" as const,
      properties: { symbol: { type: "string" , description: "Ticker symbol, e.g. AAPL." } },
      required: ["symbol"],
    },
  },
  {
    name: "get_price_history",
    description: "OHLCV price history over a date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        end: { type: "string" , description: "End date for the range (ISO 8601)." },
        frequency: { type: "string" , description: "Bar frequency, e.g. daily or weekly." },
        start: { type: "string" , description: "Start date for the range (ISO 8601)." },
        symbol: { type: "string" , description: "Ticker symbol, e.g. AAPL." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "list_macro_series",
    description: "List the macroeconomic series catalog.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_macro_series",
    description: "Fetch one macro series' observations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        end: { type: "string" , description: "End date for the range (ISO 8601)." },
        series: { type: "string" , description: "Series identifier." },
        start: { type: "string" , description: "Start date for the range (ISO 8601)." },
      },
      required: ["series"],
    },
  },
];

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "backtestport", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let out: string;
    switch (name) {
      case "engine_info":
        out = await engineInfo(a as never);
        break;
      case "get_me":
        out = await getMe(a as never);
        break;
      case "get_catalog":
        out = await getCatalog(a as never);
        break;
      case "list_indicators":
        out = await listIndicators(a as never);
        break;
      case "list_templates":
        out = await listTemplates(a as never);
        break;
      case "get_strategy_schema":
        out = await getStrategySchema(a as never);
        break;
      case "validate_strategy":
        out = await validateStrategy(a as never);
        break;
      case "run_backtest":
        out = await runBacktest(a as never);
        break;
      case "get_latest_signal":
        out = await getLatestSignal(a as never);
        break;
      case "compare_backtests":
        out = await compareBacktests(a as never);
        break;
      case "compute_stats":
        out = await computeStats(a as never);
        break;
      case "search_tickers":
        out = await searchTickers(a as never);
        break;
      case "list_tickers":
        out = await listTickers(a as never);
        break;
      case "get_data_range":
        out = await getDataRange(a as never);
        break;
      case "get_ticker_info":
        out = await getTickerInfo(a as never);
        break;
      case "get_quote":
        out = await getQuote(a as never);
        break;
      case "get_price_history":
        out = await getPriceHistory(a as never);
        break;
      case "list_macro_series":
        out = await listMacroSeries(a as never);
        break;
      case "get_macro_series":
        out = await getMacroSeries(a as never);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(out);
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
