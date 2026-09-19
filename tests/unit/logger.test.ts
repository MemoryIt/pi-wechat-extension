/**
 * tests/unit/logger.test.ts
 *
 * L1：统一控制台 logger（脱敏、级别路由、作用域、默认关闭 debug）。
 * 使用注入的 sink 捕获输出，不污染真实 console。
 */
import { test, expect } from "bun:test";
import { createLogger, redactToken, redactBody, redactUrl } from "../../src/logger.js";

interface Captured {
  log: unknown[][];
  warn: unknown[][];
  error: unknown[][];
}

function createSink(): {
  sink: {
    log: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
  calls: Captured;
} {
  const calls: Captured = { log: [], warn: [], error: [] };
  return {
    calls,
    sink: {
      log: (...a: unknown[]) => calls.log.push(a),
      warn: (...a: unknown[]) => calls.warn.push(a),
      error: (...a: unknown[]) => calls.error.push(a),
    },
  };
}

// ---------------------------------------------------------------------------
// debug 门控
// ---------------------------------------------------------------------------

test("logger：debug 默认不输出", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink });

  logger.debug("hidden");

  expect(calls.log).toHaveLength(0);
  expect(calls.warn).toHaveLength(0);
  expect(calls.error).toHaveLength(0);
});

test("logger：isDebugEnabled 为真时 debug 输出", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink, isDebugEnabled: () => true });

  logger.debug("visible");

  expect(calls.log).toHaveLength(1);
  expect(String(calls.log[0][0])).toBe("[Wechat] visible");
});

test("logger：isDebugEnabled 每次调用求值（运行期动态开关）", () => {
  const { sink, calls } = createSink();
  let enabled = false;
  const logger = createLogger({ sink, isDebugEnabled: () => enabled });

  logger.debug("off");
  enabled = true;
  logger.debug("on");

  expect(calls.log).toHaveLength(1);
  expect(String(calls.log[0][0])).toBe("[Wechat] on");
});

// ---------------------------------------------------------------------------
// 级别路由 + 前缀
// ---------------------------------------------------------------------------

test("logger：info→log / warn→warn / error→error，且带 [Wechat] 前缀", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink });

  logger.info("i");
  logger.warn("w");
  logger.error("e");

  expect(calls.log).toHaveLength(1);
  expect(calls.warn).toHaveLength(1);
  expect(calls.error).toHaveLength(1);
  expect(String(calls.log[0][0])).toBe("[Wechat] i");
  expect(String(calls.warn[0][0])).toBe("[Wechat] w");
  expect(String(calls.error[0][0])).toBe("[Wechat] e");
});

test("logger：child(scope) 生成 [Wechat][typing] 前缀", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink });
  const child = logger.child("typing");

  child.info("started");

  expect(String(calls.log[0][0])).toBe("[Wechat][typing] started");
});

test("logger：支持自定义 prefix", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink, prefix: "[X]" });

  logger.warn("w");

  expect(String(calls.warn[0][0])).toBe("[X] w");
});

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

test("logger：对象参数中的敏感字段被脱敏且保留键名", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink });

  logger.info("m", { token: "SECRET", context_token: "CTX" });

  const all = calls.log[0].map((v) => String(v)).join(" ");
  expect(all).not.toContain("SECRET");
  expect(all).not.toContain("CTX");
  expect(all).toContain("token");
  expect(all).toContain("context_token");
  expect(all).toContain("<redacted>");
});

test("logger：Error 参数只输出 message", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink });

  logger.error("failed", new Error("boom"));

  expect(calls.error[0].map((v) => String(v))).toEqual(["[Wechat] failed", "boom"]);
});

test("logger：字符串参数中的敏感 JSON 键也脱敏", () => {
  const { sink, calls } = createSink();
  const logger = createLogger({ sink });

  logger.info('body={"bot_token":"SECRET-BOT"}');

  expect(String(calls.log[0][0])).not.toContain("SECRET-BOT");
  expect(String(calls.log[0][0])).toContain("<redacted>");
});

// ---------------------------------------------------------------------------
// re-export
// ---------------------------------------------------------------------------

test("logger：re-export redactToken/redactBody/redactUrl 可用", () => {
  expect(typeof redactToken).toBe("function");
  expect(typeof redactBody).toBe("function");
  expect(typeof redactUrl).toBe("function");

  expect(redactToken("abcdef123456")).toBe("abcdef…(len=12)");
  expect(redactBody('{"token":"abc"}')).toBe('{"token":"<redacted>"}');
  expect(redactUrl("https://example.com/path?sig=abc")).toBe("https://example.com/path?<redacted>");
});
