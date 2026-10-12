/**
 * tests/channel/request-id.test.ts
 *
 * RequestIdGenerator：requestId 追踪从 `ChannelState` 迁出后的独立用例。
 * 覆盖：同毫秒唯一 / 序号递增 / 跨毫秒归零 / 格式长度（15 位时间戳 + 3 位序号）。
 *
 * `now` 用本地时间构造（`new Date(y,m,d,h,mi,s,ms)`），使精确前缀
 * `260102030405678` 的断言不依赖运行环境时区。
 */
import { test, expect } from "bun:test";
import { RequestIdGenerator } from "../../src/channel/request-id.js";

/** 本地时间 2026-01-02 03:04:05.678。 */
const NOW = new Date(2026, 0, 2, 3, 4, 5, 678).getTime();

test("同毫秒连续两次：id 不同且后缀按 000/001 递增", () => {
  const gen = new RequestIdGenerator();
  const a = gen.next(NOW);
  const b = gen.next(NOW);

  expect(a).not.toBe(b);
  expect(a.endsWith("000")).toBe(true);
  expect(b.endsWith("001")).toBe(true);
});

test("同毫秒多次：序号继续递增且保持唯一", () => {
  const gen = new RequestIdGenerator();
  const ids = [gen.next(NOW), gen.next(NOW), gen.next(NOW)];

  expect(new Set(ids).size).toBe(3);
  expect(ids[0].endsWith("000")).toBe(true);
  expect(ids[1].endsWith("001")).toBe(true);
  expect(ids[2].endsWith("002")).toBe(true);
});

test("now 变化：序号归零", () => {
  const gen = new RequestIdGenerator();
  const a = gen.next(NOW);
  const b = gen.next(NOW + 1); // 跨毫秒 → 序号归零
  const c = gen.next(NOW + 1); // 新毫秒内继续递增

  expect(a.endsWith("000")).toBe(true);
  expect(b.endsWith("000")).toBe(true);
  expect(c.endsWith("001")).toBe(true);
});

test("id 格式：15 位时间戳 + 3 位序号，总长 18", () => {
  const gen = new RequestIdGenerator();
  const id = gen.next(NOW);

  expect(id.length).toBe(18);
  expect(/^\d{18}$/.test(id)).toBe(true);
  expect(id.slice(0, 15)).toBe("260102030405678");
  expect(id.slice(15)).toBe("000");
});