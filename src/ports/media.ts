/**
 * ports/media.ts - 媒体端口（WechatMedia）
 *
 * 通道核心只关心「把一个媒体 item 落到本地并得到路径」。
 * 落盘策略（ISO 周目录 / 魔数识别 / 命名规则）不属于端口，
 * 由 channel 侧通过 `SaveMediaFn` 回调提供。
 *
 * 仅类型定义，无运行时逻辑。
 */

import type { MessageItem } from "./types.js";

/**
 * 落盘回调：由调用方实现具体目录/命名/类型判定策略。
 * 成功返回本地文件路径；失败应抛出异常。
 */
export type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  originalFilename?: string,
) => Promise<{ path: string }>;

/** download 所需依赖：CDN 基址、落盘回调、可选的日志标签。 */
export interface WechatMediaDownloadDeps {
  cdnBaseUrl: string;
  saveMedia: SaveMediaFn;
  label?: string;
}

/** download 成功结果：落盘后的本地路径。 */
export interface WechatMediaDownloadResult {
  path: string;
}

export interface WechatMedia {
  /**
   * 下载（并解密/转码）单个媒体 item 并落盘。
   * 不支持的类型或下载失败返回 null；单项失败不应抛出。
   */
  download(
    item: MessageItem,
    deps: WechatMediaDownloadDeps,
  ): Promise<WechatMediaDownloadResult | null>;
}
