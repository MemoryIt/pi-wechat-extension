/**
 * ACL: src/adapters/media.ts — 媒体下载的 Anti-Corruption Layer
 *
 * 本文件是自写层唯一接触 vendor `media/media-download.downloadMediaFromItem` 的地方。
 * 翻译：端口 3 参 `SaveMediaFn (buffer, contentType?, originalFilename?)` 适配为
 *       vendor 5 参回调 `(buffer, contentType?, subdir?, maxBytes?, originalFilename?)`。
 * 有意丢弃：vendor 的 `subdir="inbound"` 与 `maxBytes=100MB` 被 adapter 有意丢弃，
 *       落盘策略（ISO 周目录 / 命名 / 魔数）完全由调用方注入的 saveMedia 决定。
 * 翻译：从 vendor 返回的 decrypted*Path 中按 Pic > Voice > File > Video 顺序取第一个非空，
 *       无则返回 null。
 * 边界纪律：vendor 类型（WeixinInboundMediaOpts 等）、路径、全局状态不得泄漏回上层；
 *       上层只依赖 `src/ports/media.ts` 的端口类型。
 */
/**
 * media.ts - 媒体下载 adapter（WechatMedia）
 *
 * 薄包装 vendor 的 `media/media-download.downloadMediaFromItem`：
 * - 把端口 3 参 `SaveMediaFn` 适配为 vendor 需要的 5 参回调；
 * - 从 vendor 返回的 decrypted*Path 中按序取第一个非空 → `{ path }`，无则 `null`。
 *
 * 落盘策略（目录 / 命名 / 魔数）继续由调用方通过 `saveMedia` 注入，
 * adapter 不做任何目录/命名/类型判定逻辑。
 */

import { downloadMediaFromItem } from "../../media/media-download.js";
import type {
  WechatMedia,
  WechatMediaDownloadResult,
} from "../ports/media.js";
import type { MessageItem } from "../ports/types.js";

export type WechatMediaLog = (message: string) => void;

export interface WechatMediaDeps {
  log?: WechatMediaLog;
  errLog?: WechatMediaLog;
}

const NOOP_LOG: WechatMediaLog = () => {};

export function createWechatMedia(deps: WechatMediaDeps = {}): WechatMedia {
  const log = deps.log ?? NOOP_LOG;
  const errLog = deps.errLog ?? NOOP_LOG;

  return {
    async download(item: MessageItem, downloadDeps): Promise<WechatMediaDownloadResult | null> {
      const { cdnBaseUrl, saveMedia, label } = downloadDeps;

      const result = await downloadMediaFromItem(item, {
        cdnBaseUrl,
        // 端口 3 参回调 → vendor 5 参回调：忽略 subdir / maxBytes，
        // 落盘策略完全由调用方注入的 saveMedia 决定。
        saveMedia: (buffer, contentType, _subdir, _maxBytes, originalFilename) =>
          saveMedia(buffer, contentType, originalFilename),
        log,
        errLog,
        label: label ?? "media",
      });

      const path =
        result.decryptedPicPath ??
        result.decryptedVoicePath ??
        result.decryptedFilePath ??
        result.decryptedVideoPath;

      return path ? { path } : null;
    },
  };
}
