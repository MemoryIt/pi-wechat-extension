/**
 * logger.ts - 统一控制台日志 + 脱敏（仅控制台，不接文件日志）
 *
 * 设计要点：
 * - 级别映射：debug/info → sink.log；warn → sink.warn；error → sink.error。
 * - debug 仅当 isDebugEnabled() 为真时输出（默认关闭，且每次调用求值）。
 * - 每个参数先 sanitize（Error → message；string/object 走 redactBody 脱敏）再写出，
 *   避免 token / context_token 等敏感字段明文落日志。
 * - 前缀 + child(scope) 形成作用域，例如 "[Wechat][typing] "。
 */

import { redactToken, redactBody, redactUrl } from "./util/redact.js";
export { redactToken, redactBody, redactUrl };

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  log(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): PluginLogger;
}

export interface CreateLoggerOptions {
  /** 每次调用时求值，支持运行期动态开关（沿用 isDebugEnabled 语义） */
  isDebugEnabled?: () => boolean;
  prefix?: string;      // 默认 "[Wechat]"
  sink?: LogSink;       // 默认 console（便于测试注入）
}

/** 大上限：只替换敏感 JSON 键、不截断正文。 */
const SANITIZE_MAX_LEN = 100_000;

/**
 * 将任意参数转换为可安全打印的字符串：
 * - Error → 仅 message（不带 stack，避免泄漏上下文）；
 * - string → redactBody（替换敏感 JSON 键）；
 * - object → JSON.stringify 后 redactBody；
 * - 其他 → String(v)。
 */
function sanitize(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return redactBody(value, SANITIZE_MAX_LEN);
  if (typeof value === "object" && value !== null) {
    try {
      return redactBody(JSON.stringify(value), SANITIZE_MAX_LEN);
    } catch {
      // 循环引用 / BigInt 等不可序列化对象：退化为 String，保证日志本身不抛错。
      return redactBody(String(value), SANITIZE_MAX_LEN);
    }
  }
  return String(value);
}

class ConsolePluginLogger implements PluginLogger {
  private readonly sink: LogSink;
  private readonly isDebugEnabled: () => boolean;
  private readonly prefix: string;

  constructor(sink: LogSink, isDebugEnabled: () => boolean, prefix: string) {
    this.sink = sink;
    this.isDebugEnabled = isDebugEnabled;
    this.prefix = prefix;
  }

  private write(method: "log" | "warn" | "error", message: string, args: unknown[]): void {
    this.sink[method](`${this.prefix} ${sanitize(message)}`, ...args.map(sanitize));
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      this.write("log", message, args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    this.write("log", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write("warn", message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write("error", message, args);
  }

  child(scope: string): PluginLogger {
    return new ConsolePluginLogger(this.sink, this.isDebugEnabled, `${this.prefix}[${scope}]`);
  }
}

export function createLogger(options: CreateLoggerOptions = {}): PluginLogger {
  const sink = options.sink ?? console;
  const isDebugEnabled = options.isDebugEnabled ?? (() => false);
  const prefix = options.prefix ?? "[Wechat]";
  return new ConsolePluginLogger(sink, isDebugEnabled, prefix);
}
