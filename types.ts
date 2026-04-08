/**
 * 微信插件类型定义
 */

/**
 * 连接状态
 */
export type ConnectionState =
  | "disconnected"   // 未连接
  | "connecting"     // 连接中
  | "connected"      // 已连接
  | "error"          // 连接错误
  | "needs_relogin"; // 需要重新登录

/**
 * WechatEngine 接口（用于类型检查）
 */
export interface WechatEngine {
  connectionState: ConnectionState;
  syncCursor: string;
  stopPolling(): void;
}
