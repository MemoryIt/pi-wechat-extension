/**
 * tool-send-file.ts - send_wechat_file 工具
 *
 * 从 index.ts 拆出：允许 AI 向当前微信用户发送本地文件。
 * 通过 `createSendFileTool(channel, logger)` 注入 `Channel` 与共享 logger。
 */

import { Type, type Static } from "@sinclair/typebox";
import path from "node:path";
import { existsSync } from "node:fs";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Channel } from "../channel/channel.js";
import type { PluginLogger } from "../shared/logger.js";

export function createSendFileTool(channel: Channel, logger: PluginLogger): ToolDefinition {
  const sendFileParams = Type.Object({
    localPath: Type.String({
      description: "必须填写：Pi 本地文件的**完整绝对路径**（例如 /Users/mou/code/pi-dev/Agent.pptx）",
    }),
  });

  const sendFileTool: ToolDefinition<typeof sendFileParams> = {
    name: "send_wechat_file",
    label: "Send WeChat file",
    description:
      "向当前微信用户发送本地文件。必须提供文件的**完整绝对路径**（如 /Users/mou/code/pi-dev/Agent.pptx）。" +
      "支持任意文件类型（pptx、pdf、jpg、png 等）。微信端将以该文件的本地文件名作为显示名。",
    parameters: sendFileParams,
    execute: async (
      toolCallId: string,
      params: Static<typeof sendFileParams>,
    ): Promise<AgentToolResult<unknown>> => {
      logger.debug(`send_wechat_file tool called - toolCallId=${toolCallId}, params=`, JSON.stringify(params));

      if (!params || typeof params !== "object") {
        const errMsg = "工具调用参数错误：请提供 localPath 参数";
        logger.debug(errMsg);
        throw new Error(errMsg);
      }

      const { localPath } = params;

      if (!localPath || typeof localPath !== "string" || localPath.trim() === "") {
        const errMsg = "必须提供 localPath 参数（文件的完整绝对路径）。例如：/Users/mou/code/pi-dev/Agent.pptx";
        logger.debug(errMsg);
        throw new Error(errMsg);
      }

      const trimmedPath = localPath.trim();
      if (!existsSync(trimmedPath)) {
        const errMsg = `文件不存在: ${trimmedPath} （请确认路径是否正确，且文件在当前工作目录或指定绝对路径下）`;
        logger.debug(errMsg);
        throw new Error(errMsg);
      }

      // 底层 sendFileToUser 不再支持自定义显示名，以本地文件名为准。
      const displayName = path.basename(trimmedPath);
      logger.debug(`准备发送文件: ${displayName} (${trimmedPath})`);

      try {
        await channel.sendFile(trimmedPath);
        const successMsg = `文件 "${displayName}" 已成功发送至微信`;
        logger.debug(successMsg);
        return { content: [{ type: "text", text: successMsg }], details: {} };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.debug(`sendFile 执行失败:`, errMsg);
        // SDK 约定：工具失败需通过 throw 上报（结果会带上 isError=true）。
        throw new Error(`发送文件失败: ${errMsg}`);
      }
    },
  };

  return sendFileTool;
}
