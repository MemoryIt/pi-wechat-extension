/**
 * tests/channel/polling.test.ts
 *
 * F6：直接单测 `PollingLoop`（fake deps），验证「单条消息处理失败」被隔离：
 * - 同一批次中某条 `onMessage` 抛错，其余消息仍被处理；
 * - 只要 `getUpdates` 成功，批次 cursor 仍会持久化；
 * - 正常路径行为不变。
 *
 * 用「首次 getUpdates 返回批次、后续挂起」+ `stop()` 结束循环，避免无限轮询。
 */
import { test, expect, mock } from "bun:test";
import { PollingLoop } from "../../src/channel/polling.js";
import type { PollingLoopDeps } from "../../src/channel/polling.js";
import type { WeixinMessage } from "../../src/ports/types.js";
import { MessageItemType } from "../../src/ports/types.js";

const opts = { baseUrl: "https://example.com", token: "tok" };

function textMessage(text: string): WeixinMessage {
  return {
    context_token: "CTX-1",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

function messageText(msg: WeixinMessage): string {
  return msg.item_list?.[0]?.text_item?.text ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

/**
 * 组装 fake deps：首批返回给定 messages + cursor，后续 getUpdates 挂起，
 * 直到 `stop()` abort 抢跑退出。
 */
function makeDeps(overrides: {
  messages: WeixinMessage[];
  cursor: string;
  onMessage: (msg: WeixinMessage) => Promise<void>;
}) {
  const saveCursor = mock(async (_accountId: string, _cursor: string) => {});
  const error = mock((_message: string, ..._args: unknown[]) => {});
  let call = 0;

  const deps: PollingLoopDeps = {
    ensureSession: async () => true,
    getAccountId: () => "acc1",
    loadCursor: async () => "",
    saveCursor,
    inbound: {
      getUpdates: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({ messages: overrides.messages, cursor: overrides.cursor });
        }
        return new Promise(() => {});
      },
    },
    onMessage: overrides.onMessage,
    onNeedsRelogin: () => {},
    debug: () => {},
    error,
    sleep: async () => {},
  };

  return { deps, saveCursor, error };
}

test("F6 目标：某条 onMessage 抛错时，同批次剩余消息仍被处理且 cursor 仍持久化", async () => {
  const processed: string[] = [];
  const { deps, saveCursor, error } = makeDeps({
    messages: [textMessage("m1"), textMessage("m2")],
    cursor: "cursor-batch",
    onMessage: async (msg) => {
      const text = messageText(msg);
      if (text === "m1") throw new Error("boom on m1");
      processed.push(text);
    },
  });

  const loop = new PollingLoop(deps);
  const p = loop.start(opts);

  // 等待「错误被记录」或「cursor 被持久化」后停止循环
  await waitFor(() => error.mock.calls.length > 0 || saveCursor.mock.calls.length > 0);
  loop.stop();
  await p;

  expect(processed).toEqual(["m2"]);
  expect(error).toHaveBeenCalledTimes(1);
  expect(saveCursor).toHaveBeenCalledWith("acc1", "cursor-batch");
});

test("F6 基线：正常批次两条消息都处理、无 error、cursor 持久化", async () => {
  const processed: string[] = [];
  const { deps, saveCursor, error } = makeDeps({
    messages: [textMessage("m1"), textMessage("m2")],
    cursor: "cursor-ok",
    onMessage: async (msg) => {
      processed.push(messageText(msg));
    },
  });

  const loop = new PollingLoop(deps);
  const p = loop.start(opts);

  await waitFor(() => saveCursor.mock.calls.length > 0);
  loop.stop();
  await p;

  expect(processed).toEqual(["m1", "m2"]);
  expect(error).not.toHaveBeenCalled();
  expect(saveCursor).toHaveBeenCalledWith("acc1", "cursor-ok");
});
