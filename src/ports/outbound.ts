/**
 * ports/outbound.ts - 出站消息端口（WechatOutbound）
 *
 * 凭证（baseUrl / token / userId / contextToken）由 adapter 构造时注入的
 * provider 提供，端口方法本身不带任何凭证参数。
 *
 * 仅类型定义，无运行时逻辑。
 */

export interface WechatOutbound {
  /** 发送纯文本消息。 */
  sendText(text: string): Promise<void>;

  /** 发送本地文件（底层按类型自动路由图片/视频/文件）。 */
  sendFile(localPath: string): Promise<void>;

  /**
   * 发送 typing 指示灯状态。
   * 1 = typing（默认），2 = cancel typing。
   * ticket 由调用方（TypingController）缓存并提供，端口不做缓存。
   */
  sendTyping(status: 1 | 2, ticket: string): Promise<void>;

  /** 获取 typing_ticket（直连 getConfig，无缓存）；凭证缺失或获取失败时返回 null。 */
  getTypingTicket(): Promise<string | null>;
}
