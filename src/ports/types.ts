/**
 * ports/types.ts - 端口层类型边界
 *
 * 端口层唯一允许直接依赖 `api/types` 的文件：在此集中 re-export 通道真正
 * 需要的协议类型，端口与后续 adapter 一律从本模块取用，避免第三方协议类型
 * 在 ports/adapters 中散落。
 *
 * 仅类型/常量转发，无任何运行时逻辑。
 */

export type { WeixinMessage, MessageItem } from "../../api/types.js";
export { MessageItemType } from "../../api/types.js";

/**
 * 出站 adapter 所需的完整凭证（含单用户 contextToken）。
 * 与 `engine/typing.ts` 的 `TypingCredentials` 字段对齐，作为 ports 层的公共类型。
 */
export interface WechatCredentials {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken: string;
}
