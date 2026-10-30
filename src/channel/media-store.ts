/**
 * media-store.ts - 媒体落盘与魔数识别
 *
 * 负责媒体文件落盘与识别：
 * - ISO 周目录 / 文件类型魔数识别 / MIME 映射
 * - MediaStore：save（单文件落盘）、createSaveCallback（端口 3 参 SaveMediaFn）、
 *   downloadAll（经 WechatMedia 端口批量下载并收集本地路径）
 *
 * 最初自 wechat.ts 抽出。
 */

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getMediaStoragePath } from "../shared/config.js";
import { MessageItemType } from "../ports/types.js";
import type { MessageItem } from "../ports/types.js";
import type { SaveMediaFn, WechatMedia } from "../ports/media.js";
import { formatTimestamp } from "../shared/time.js";

// ============== 媒体存储配置 ==============

/**
 * 获取 ISO 周数
 */
export function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * 获取当前 ISO 周文件夹名称，格式: {year}{week} (如 "2605")
 */
export function getCurrentWeekFolder(): string {
  const now = new Date();
  const year = now.getFullYear();
  const week = getISOWeek(now);
  return `${String(year).slice(-2)}${String(week).padStart(2, '0')}`;
}

/**
 * MIME 类型到扩展名的映射
 */
export const CONTENT_TYPE_EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "audio/wav": "wav",
  "audio/silk": "silk",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/**
 * 根据文件头魔数（Magic Bytes）检测文件类型
 */
export function detectFileType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return "jpg";
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return "png";
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "gif";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer.length >= 8 && buffer[4] === 0x57 && buffer[5] === 0x45 && buffer[6] === 0x42 && buffer[7] === 0x50) {
      return "webp";
    }
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return "bmp";
  }
  // MP4/QuickTime: 66 74 79 70 (ftyp)
  if (buffer[0] === 0x66 && buffer[1] === 0x74 && buffer[2] === 0x79 && buffer[3] === 0x70) {
    return "mp4";
  }
  // SILK: 02 开头
  if (buffer[0] === 0x02) {
    return "silk";
  }
  // OGG: 4F 67 67 53 (OggS)
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return "ogg";
  }

  return null;
}

/** 未注入 media 端口时的降级实现：不下载、返回 null。 */
const UNAVAILABLE_MEDIA: WechatMedia = {
  async download() {
    return null;
  },
};

export interface MediaStoreOptions {
  getBasePath?: () => string;
  /** 媒体下载端口；由组合根注入，单测可注入 fake。 */
  media?: WechatMedia;
  log?: (...a: unknown[]) => void;
  errLog?: (...a: unknown[]) => void;
}

/**
 * 媒体存储：负责单文件落盘与批量下载。
 */
export class MediaStore {
  private readonly getBasePath: () => string;
  private readonly media: WechatMedia;
  private readonly log: (...a: unknown[]) => void;
  private readonly errLog: (...a: unknown[]) => void;

  constructor(opts: MediaStoreOptions = {}) {
    this.getBasePath = opts.getBasePath ?? getMediaStoragePath;
    this.media = opts.media ?? UNAVAILABLE_MEDIA;
    this.log = opts.log ?? console.log;
    this.errLog = opts.errLog ?? console.error;
  }

  /**
   * 保存媒体文件到存储
   * 路径: {basePath}/{year}{week}/{timestamp}_{uuid8}.{ext}
   * 扩展名优先级: originalFilename 后缀 > contentType 映射 > 魔数 > bin
   */
  save(buffer: Buffer, contentType?: string, originalFilename?: string): string {
    let ext: string;
    if (originalFilename) {
      ext = originalFilename.split('.').pop() ?? 'bin';
    } else if (contentType) {
      ext = CONTENT_TYPE_EXT_MAP[contentType] ?? 'bin';
    } else {
      // 尝试通过魔数检测
      ext = detectFileType(buffer) ?? 'bin';
    }

    const basePath = this.getBasePath();
    const weekFolder = getCurrentWeekFolder();
    const targetDir = join(basePath, weekFolder);

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const filename = `${formatTimestamp(new Date())}_${randomUUID().slice(0, 8)}.${ext}`;
    const filepath = join(targetDir, filename);
    writeFileSync(filepath, buffer);
    return filepath;
  }

  /**
   * 落盘回调（端口 3 参 SaveMediaFn）：目录/命名/类型判定仍由本类决定。
   */
  createSaveCallback(): SaveMediaFn {
    return async (buffer, contentType, originalFilename) => {
      const path = this.save(buffer, contentType, originalFilename);
      return { path };
    };
  }

  /**
   * 遍历消息中的非文本 item，逐个经 media 端口下载并落盘，收集本地路径。
   * 单项失败记录 errLog 后继续，不影响其它 item。
   */
  async downloadAll(
    items: MessageItem[],
    cdnBaseUrl: string,
    labelPrefix = "media",
  ): Promise<string[]> {
    const saveMedia = this.createSaveCallback();
    const paths: string[] = [];

    for (const item of items) {
      if (item.type === MessageItemType.TEXT) continue;

      try {
        const result = await this.media.download(item, {
          cdnBaseUrl,
          saveMedia,
          label: `${labelPrefix}-${item.type}`,
        });

        if (result?.path) {
          paths.push(result.path);
          this.log(`Media saved: ${result.path}`);
        }
      } catch (err) {
        this.errLog(`Media download failed for type ${item.type}:`, err);
      }
    }

    return paths;
  }
}
