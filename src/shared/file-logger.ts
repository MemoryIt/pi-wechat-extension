/**
 * file-logger.ts - 文件日志再导出边界
 *
 * `util/logger.ts` 被 vendor 内部（api/auth/cdn/media/messaging）大量引用，
 * 不可移动/删除。本模块仅作为自写代码的薄再导出边界，便于后续替换实现。
 */

export { logger, setLogLevel } from "../../util/logger.js";
