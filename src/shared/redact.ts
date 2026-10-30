/**
 * redact.ts - 脱敏工具再导出边界
 *
 * `util/redact.ts` 被 vendor 内部（api/auth/cdn/media/messaging）大量引用，
 * 不可移动/删除。本模块仅作为自写代码的薄再导出边界，便于后续替换实现。
 */

export { redactToken, redactBody, redactUrl } from "../../util/redact.js";
