#!/usr/bin/env node
/**
 * backtestport CLI.
 *
 *   backtestport <tool> '<json>'
 *   backtestport mcp
 *   backtestport --version
 *
 * Each tool subcommand takes one JSON argument string with the
 * tool's arguments and prints the tool's result text. Exit
 * codes: 0 success, 1 runtime error, 2 usage error.
 */
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

const TOOL_NAMES = [
  "engine_info",
  "get_me",
  "get_catalog",
  "list_indicators",
  "list_templates",
  "get_strategy_schema",
  "validate_strategy",
  "run_backtest",
  "get_latest_signal",
  "compare_backtests",
  "compute_stats",
  "search_tickers",
  "list_tickers",
  "get_data_range",
  "get_ticker_info",
  "get_quote",
  "get_price_history",
  "list_macro_series",
  "get_macro_series",
] as const;

function usage(): never {
  console.error(`Usage:
  backtestport <tool> '<json-args>'     one of: ${TOOL_NAMES.join(", ")}
  backtestport mcp
  backtestport --version`);
  process.exit(2);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "engine_info":
      return engineInfo(args as never);
    case "get_me":
      return getMe(args as never);
    case "get_catalog":
      return getCatalog(args as never);
    case "list_indicators":
      return listIndicators(args as never);
    case "list_templates":
      return listTemplates(args as never);
    case "get_strategy_schema":
      return getStrategySchema(args as never);
    case "validate_strategy":
      return validateStrategy(args as never);
    case "run_backtest":
      return runBacktest(args as never);
    case "get_latest_signal":
      return getLatestSignal(args as never);
    case "compare_backtests":
      return compareBacktests(args as never);
    case "compute_stats":
      return computeStats(args as never);
    case "search_tickers":
      return searchTickers(args as never);
    case "list_tickers":
      return listTickers(args as never);
    case "get_data_range":
      return getDataRange(args as never);
    case "get_ticker_info":
      return getTickerInfo(args as never);
    case "get_quote":
      return getQuote(args as never);
    case "get_price_history":
      return getPriceHistory(args as never);
    case "list_macro_series":
      return listMacroSeries(args as never);
    case "get_macro_series":
      return getMacroSeries(args as never);
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!(TOOL_NAMES as readonly string[]).includes(cmd ?? "")) usage();
  if (rest.length > 1) usage();
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  try {
    const out = await runTool(cmd, args);
    console.log(out);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
