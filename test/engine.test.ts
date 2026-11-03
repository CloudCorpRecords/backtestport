import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareBacktests,
  computeStats,
  engineInfo,
  getCatalog,
  getLatestSignal,
  getMacroSeries,
  getMe,
  getPriceHistory,
  getTickerInfo,
  listTemplates,
  runBacktest,
  searchTickers,
  validateStrategy,
} from "../src/engine.js";
import type { EngineDeps, FetchFn } from "../src/types.js";

/**
 * Every test runs against an injected fake fetch and an
 * injected env: no live network, no live call is made.
 * The CLI tests spawn the real CLI through tsx and only
 * exercise paths that fail before any request (version,
 * usage, validation, missing key).
 */

type Captured = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function makeFetch(
  handler: (url: string) => {
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  },
  captured: Captured[] = [],
): FetchFn {
  return async (url, init) => {
    captured.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const r = handler(url);
    const status = r.status ?? 200;
    const headerMap = new Map(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
}

const okFetch = (body: unknown = { ok: true }, captured: Captured[] = []) =>
  makeFetch(() => ({ body }), captured);

const throwingFetch: FetchFn = async () => {
  throw new Error("connection refused");
};

/** A fetch that never settles until its signal aborts, then rejects with AbortError. */
const abortingFetch: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abortError = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return err;
    };
    if (!signal) return; // never settles
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

function deps(fetchFn: FetchFn, extra: Partial<EngineDeps> = {}): EngineDeps {
  return { fetchFn, env: { BACKTEST360_API_KEY: "test-key" }, ...extra };
}

function noKeyDeps(fetchFn: FetchFn, extra: Partial<EngineDeps> = {}): EngineDeps {
  return { fetchFn, env: {}, ...extra };
}

async function expectError(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal(err instanceof Error ? err.message : String(err), message);
    return true;
  });
}

const STRATEGY = { name: "sma-cross", rules: [{ op: "cross_above", fast: 10, slow: 30 }] };

describe("missing API key", () => {
  it("fails engine_info with the pinned message and makes no request", async () => {
    const captured: Captured[] = [];
    await expectError(engineInfo({}, noKeyDeps(okFetch({}, captured))), "BACKTEST360_API_KEY is not set");
    assert.deepEqual(captured, []);
  });

  it("fails run_backtest with the pinned message and makes no request", async () => {
    const captured: Captured[] = [];
    await expectError(
      runBacktest({ strategy: STRATEGY }, noKeyDeps(okFetch({}, captured))),
      "BACKTEST360_API_KEY is not set",
    );
    assert.deepEqual(captured, []);
  });

  it("treats an empty-string key as missing", async () => {
    await expectError(
      engineInfo({}, deps(okFetch(), { env: { BACKTEST360_API_KEY: "" } })),
      "BACKTEST360_API_KEY is not set",
    );
  });
});

describe("GET wire paths", () => {
  it("GETs <base>/engine/info with the X-API-Key header and returns the body verbatim", async () => {
    const captured: Captured[] = [];
    const body = { version: "3.2.1", contract: "v1", healthy: true };
    const out = await engineInfo({}, deps(okFetch(body, captured)));
    assert.equal(out, JSON.stringify(body));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://api.backtest360.com/engine/info");
    assert.equal(captured[0].method, "GET");
    assert.equal(captured[0].headers?.["X-API-Key"], "test-key");
    assert.equal(captured[0].body, undefined);
  });

  it("GETs <base>/me", async () => {
    const captured: Captured[] = [];
    await getMe({}, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/me");
  });

  it("reads the base URL from env and trims a trailing slash", async () => {
    const captured: Captured[] = [];
    await engineInfo(
      {},
      deps(okFetch({}, captured), {
        env: { BACKTEST360_API_KEY: "env-key", BACKTEST360_ENGINE_URL: "https://engine.example.test/v2/" },
      }),
    );
    assert.equal(captured[0].url, "https://engine.example.test/v2/engine/info");
    assert.equal(captured[0].headers?.["X-API-Key"], "env-key");
  });

  it("GETs the whole catalog reference when catalog is omitted", async () => {
    const captured: Captured[] = [];
    await getCatalog({}, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/catalogs");
  });

  it("passes catalog as a query parameter when given", async () => {
    const captured: Captured[] = [];
    await getCatalog({ catalog: "operators" }, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/catalogs?catalog=operators");
  });

  it("lists templates at <base>/templates and fetches one by encoded id", async () => {
    const listCap: Captured[] = [];
    await listTemplates({}, deps(okFetch({}, listCap)));
    assert.equal(listCap[0].url, "https://api.backtest360.com/templates");
    const oneCap: Captured[] = [];
    await listTemplates({ id: "momentum/basic v2" }, deps(okFetch({}, oneCap)));
    assert.equal(oneCap[0].url, "https://api.backtest360.com/templates/momentum%2Fbasic%20v2");
  });

  it("searches tickers with an encoded q parameter", async () => {
    const captured: Captured[] = [];
    await searchTickers({ query: "apple inc" }, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/tickers/search?q=apple+inc");
  });

  it("URL-encodes the symbol path segment", async () => {
    const captured: Captured[] = [];
    await getTickerInfo({ symbol: "BRK/B" }, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/tickers/BRK%2FB");
  });

  it("forwards price-history range and frequency as query parameters", async () => {
    const captured: Captured[] = [];
    await getPriceHistory(
      { symbol: "AAPL", start: "2024-01-01", end: "2024-12-31", frequency: "1d" },
      deps(okFetch({}, captured)),
    );
    assert.equal(
      captured[0].url,
      "https://api.backtest360.com/tickers/AAPL/history?start=2024-01-01&end=2024-12-31&frequency=1d",
    );
  });

  it("fetches one macro series with its date range", async () => {
    const captured: Captured[] = [];
    await getMacroSeries(
      { series: "CPIAUCSL", start: "2020-01-01" },
      deps(okFetch({}, captured)),
    );
    assert.equal(captured[0].url, "https://api.backtest360.com/macro/CPIAUCSL?start=2020-01-01");
    assert.equal(captured[0].method, "GET");
  });
});

describe("strategy arguments", () => {
  it("POSTs an object strategy to <base>/strategy/validate", async () => {
    const captured: Captured[] = [];
    await validateStrategy({ strategy: STRATEGY }, deps(okFetch({ valid: true }, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/strategy/validate");
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].headers?.["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), { strategy: STRATEGY });
  });

  it("parses a strategy given as a JSON string before sending it", async () => {
    const captured: Captured[] = [];
    await validateStrategy({ strategy: JSON.stringify(STRATEGY) }, deps(okFetch({}, captured)));
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), { strategy: STRATEGY });
  });

  it("rejects a strategy string that is not valid JSON and makes no request", async () => {
    const captured: Captured[] = [];
    await expectError(
      validateStrategy({ strategy: "{not json" }, deps(okFetch({}, captured))),
      "strategy is not valid JSON",
    );
    assert.deepEqual(captured, []);
  });

  it("rejects a missing strategy", async () => {
    await expectError(
      validateStrategy({} as never, deps(okFetch())),
      "strategy is required",
    );
  });

  it("POSTs the latest-signal body with the optional symbol", async () => {
    const captured: Captured[] = [];
    await getLatestSignal({ strategy: STRATEGY, symbol: "MSFT" }, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/signals/latest");
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), { strategy: STRATEGY, symbol: "MSFT" });
  });

  it("normalises JSON-string items inside compare_backtests", async () => {
    const captured: Captured[] = [];
    const other = { name: "mean-reversion" };
    await compareBacktests(
      { strategies: [JSON.stringify(STRATEGY), other] },
      deps(okFetch({}, captured)),
    );
    assert.equal(captured[0].url, "https://api.backtest360.com/backtests/compare");
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), { strategies: [STRATEGY, other] });
  });

  it("rejects an empty strategies array and a bad-JSON item", async () => {
    await expectError(
      compareBacktests({ strategies: [] }, deps(okFetch())),
      "strategies must be a non-empty array",
    );
    await expectError(
      compareBacktests({ strategies: ["{oops"] }, deps(okFetch())),
      "strategy is not valid JSON",
    );
  });
});

describe("run_backtest options", () => {
  it("forwards every optional field that is given", async () => {
    const captured: Captured[] = [];
    await runBacktest(
      {
        strategy: STRATEGY,
        symbol: "AAPL",
        start: "2023-01-01",
        end: "2023-12-31",
        response_detail: "full",
        max_series_points: 250,
        include: ["trades", "equity_curve"],
        data: { bars: [{ close: 101.5 }] },
      },
      deps(okFetch({}, captured)),
    );
    assert.equal(captured[0].url, "https://api.backtest360.com/backtests");
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), {
      strategy: STRATEGY,
      symbol: "AAPL",
      start: "2023-01-01",
      end: "2023-12-31",
      response_detail: "full",
      max_series_points: 250,
      include: ["trades", "equity_curve"],
      data: { bars: [{ close: 101.5 }] },
    });
  });

  it("omits optional fields that are not given", async () => {
    const captured: Captured[] = [];
    await runBacktest({ strategy: STRATEGY }, deps(okFetch({}, captured)));
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), { strategy: STRATEGY });
  });

  it("rejects max_series_points below 2 and makes no request", async () => {
    const captured: Captured[] = [];
    await expectError(
      runBacktest({ strategy: STRATEGY, max_series_points: 1 }, deps(okFetch({}, captured))),
      "max_series_points must be an integer >= 2",
    );
    assert.deepEqual(captured, []);
  });

  it("rejects a non-integer max_series_points", async () => {
    await expectError(
      runBacktest({ strategy: STRATEGY, max_series_points: 2.5 }, deps(okFetch())),
      "max_series_points must be an integer >= 2",
    );
    await expectError(
      compareBacktests({ strategies: [STRATEGY], max_series_points: 0 }, deps(okFetch())),
      "max_series_points must be an integer >= 2",
    );
  });

  it("accepts max_series_points exactly at the bound of 2", async () => {
    const captured: Captured[] = [];
    await runBacktest({ strategy: STRATEGY, max_series_points: 2 }, deps(okFetch({}, captured)));
    assert.equal(JSON.parse(captured[0].body ?? "").max_series_points, 2);
  });

  it("POSTs a returns series to <base>/stats and validates it first", async () => {
    const captured: Captured[] = [];
    await computeStats({ returns: [0.01, -0.02, 0.005] }, deps(okFetch({}, captured)));
    assert.equal(captured[0].url, "https://api.backtest360.com/stats");
    assert.deepEqual(JSON.parse(captured[0].body ?? ""), { returns: [0.01, -0.02, 0.005] });
    await expectError(
      computeStats({ returns: [0.01, "x"] } as never, deps(okFetch())),
      "returns must be an array of numbers",
    );
  });
});

describe("engine verdicts are normal results, not errors", () => {
  it("returns a {valid: false} validation body verbatim as a normal result", async () => {
    const body = { valid: false, errors: [{ path: "rules[0].op", message: "unknown operator" }] };
    const out = await validateStrategy({ strategy: STRATEGY }, deps(okFetch(body)));
    assert.equal(out, JSON.stringify(body));
  });

  it("returns an {accepted: false} backtest body verbatim as a normal result", async () => {
    const body = { accepted: false, reason: "insufficient history for symbol" };
    const out = await runBacktest({ strategy: STRATEGY, symbol: "ZZZZ" }, deps(okFetch(body)));
    assert.equal(out, JSON.stringify(body));
  });

  it("returns a string body verbatim, without JSON re-serialisation", async () => {
    const raw = '{ "valid" :  true,  "errors" : [ ] }';
    const out = await validateStrategy({ strategy: STRATEGY }, deps(okFetch(raw)));
    assert.equal(out, raw);
  });
});

describe("output byte cap", () => {
  it("truncates an over-cap body and appends the marker line", async () => {
    const body = "x".repeat(500);
    const out = await engineInfo({}, deps(okFetch(body), { maxOutputBytes: 100 }));
    assert.equal(out, `${"x".repeat(100)}\n{"truncated_by_mcp": true}`);
  });

  it("leaves a body exactly at the cap untouched", async () => {
    const body = "y".repeat(100);
    const out = await engineInfo({}, deps(okFetch(body), { maxOutputBytes: 100 }));
    assert.equal(out, body);
  });

  it("reads the cap from BACKTEST360_MCP_MAX_OUTPUT_BYTES", async () => {
    const body = "z".repeat(50);
    const out = await engineInfo(
      {},
      deps(okFetch(body), {
        env: { BACKTEST360_API_KEY: "k", BACKTEST360_MCP_MAX_OUTPUT_BYTES: "10" },
      }),
    );
    assert.equal(out, `${"z".repeat(10)}\n{"truncated_by_mcp": true}`);
  });
});

describe("upstream errors", () => {
  it("maps HTTP 429 with a Retry-After header to the pinned rate-limit message", async () => {
    const fetchFn = makeFetch(() => ({
      status: 429,
      body: "slow down",
      headers: { "Retry-After": "30" },
    }));
    await expectError(
      engineInfo({}, deps(fetchFn)),
      "backtest360 rate limited (HTTP 429); retry after 30",
    );
  });

  it("maps HTTP 429 without Retry-After to the rate-limit message without a suffix", async () => {
    const fetchFn = makeFetch(() => ({ status: 429, body: "slow down" }));
    await expectError(engineInfo({}, deps(fetchFn)), "backtest360 rate limited (HTTP 429)");
  });

  it("maps other non-2xx replies to backtest360 error: HTTP <status>", async () => {
    const fetchFn = makeFetch(() => ({ status: 500, body: "boom" }));
    await expectError(getMe({}, deps(fetchFn)), "backtest360 error: HTTP 500");
    const notFound = makeFetch(() => ({ status: 404, body: "nope" }));
    await expectError(
      getTickerInfo({ symbol: "ZZZZ" }, deps(notFound)),
      "backtest360 error: HTTP 404",
    );
  });

  it("maps a throwing fetch to backtest360 unreachable", async () => {
    await expectError(engineInfo({}, deps(throwingFetch)), "backtest360 unreachable");
  });

  it("maps an aborting fetch (timeout) to backtest360 request timed out", async () => {
    await expectError(
      engineInfo({}, deps(abortingFetch, { timeoutMs: 10 })),
      "backtest360 request timed out",
    );
  });

  it("maps a fetch that throws AbortError directly to the timeout message", async () => {
    const abortThrowing: FetchFn = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    await expectError(getMe({}, deps(abortThrowing)), "backtest360 request timed out");
  });
});

/* ------------------------------------------------------------------ */
/* CLI (spawned through tsx; only pre-request paths are exercised)     */
/* ------------------------------------------------------------------ */

function runCli(args: string[], env: Record<string, string> = {}) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return spawnSync(join(root, "node_modules", ".bin", "tsx"), ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BACKTEST360_API_KEY: "",
      BACKTEST360_ENGINE_URL: "",
      BACKTEST360_MCP_TIMEOUT: "",
      BACKTEST360_MCP_MAX_OUTPUT_BYTES: "",
      ...env,
    },
  });
}

describe("backtestport CLI", () => {
  it("prints 0.1.0 for --version and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("exits 2 with usage for an unknown subcommand", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage/);
  });

  it("exits 2 for a non-JSON argument string", () => {
    const res = runCli(["run_backtest", "not json"]);
    assert.equal(res.status, 2);
  });

  it("exits 1 with the missing-key message when no key is configured", () => {
    const res = runCli(["engine_info", "{}"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BACKTEST360_API_KEY is not set/);
  });

  it("exits 1 with the pinned message for max_series_points below 2", () => {
    const res = runCli(
      ["run_backtest", JSON.stringify({ strategy: STRATEGY, max_series_points: 1 })],
      { BACKTEST360_API_KEY: "k" },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /max_series_points must be an integer >= 2/);
  });

  it("exits 1 with the pinned message for a strategy string that is not valid JSON", () => {
    const res = runCli(
      ["validate_strategy", JSON.stringify({ strategy: "{broken" })],
      { BACKTEST360_API_KEY: "k" },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /strategy is not valid JSON/);
  });
});
