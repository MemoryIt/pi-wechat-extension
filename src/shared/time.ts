/**
 * time.ts - 共享时间工具
 *
 * 统一时间戳：YYMMDDHHMMSSmmm (15 位，本地时间)。
 * requestId（wechat.ts）与媒体文件名（media-store.ts）共用。
 */

export function formatTimestamp(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yy}${mm}${dd}${hh}${min}${ss}${ms}`;
}

/** 睡眠指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
