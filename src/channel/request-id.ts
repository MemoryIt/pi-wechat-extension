/**
 * channel/request-id.ts - 请求 ID 生成器
 *
 * requestId 追踪从 `ChannelState` 抽出的独立追踪器：仅负责
 * `YYMMDDHHMMSSmmm` + 3 位同毫秒序号的请求 ID 生成，使 `ChannelState`
 * 收敛为「凭证 + 运行期依赖 + 终端标志」。
 *
 * 依赖方向：只依赖 `shared/time` 的 `formatTimestamp`，不感知 Channel /
 * 端口 / 存储。
 */

import { formatTimestamp } from "../shared/time.js";

/**
 * 请求 ID 生成器。
 *
 * - `next()` 产出 `YYMMDDHHMMSSmmm` + 3 位序号（总长 18）；
 * - 同一 `now` 连续调用：序号递增（000 → 001 → …），id 唯一；
 * - `now` 变化：序号归零。
 */
export class RequestIdGenerator {
  private lastMs = -1;
  private seq = 0;

  /** 生成下一个请求 ID；`now` 缺省取 `Date.now()`（测试可注入固定毫秒）。 */
  next(now: number = Date.now()): string {
    if (now !== this.lastMs) {
      this.lastMs = now;
      this.seq = 0;
    } else {
      this.seq += 1;
    }
    return `${formatTimestamp(new Date(now))}${String(this.seq).padStart(3, "0")}`;
  }
}