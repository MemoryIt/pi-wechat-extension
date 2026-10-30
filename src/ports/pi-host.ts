/**
 * ports/pi-host.ts - 宿主端口（PiHost）
 *
 * Wechat 通道对 pi 宿主的最小依赖：写入 entry、把用户消息交给 agent、
 * 以 custom message 形式回写历史。等价于旧的宿主窄接口，
 * 供组合根/适配器注入。
 *
 * 仅类型定义，无运行时逻辑。
 */

export interface PiHost {
  appendEntry(customType: string, data?: unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}
