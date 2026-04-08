/**
 * storage/state.ts
 * 
 * 持久化存储：登录凭证、context tokens、sync cursor
 * 
 * 目录结构：
 * ~/.pi/agent/wechat/
 * ├── accounts.json
 * └── accounts/
 *     └── {accountId}/
 *         ├── account.json
 *         ├── token.json          # chmod 600
 *         ├── context-tokens.json
 *         └── sync.json
 */

import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../util/logger.js";

// ============== 类型定义 ==============

export interface WechatToken {
  botToken: string;
  accountId: string;
  userId: string;
  baseUrl: string;
  /** 登录时间（毫秒） */
  loginAt: number;
}

export interface AccountInfo {
  accountId: string;
  displayName: string;
  loginAt: number;
}

export interface ContextTokenEntry {
  /** 用户 display name（如"张三"） */
  displayName: string;
  /** ilink context token */
  contextToken: string;
  /** 上次消息时间 */
  lastMessageAt?: number;
}

export interface ContextTokens {
  [userId: string]: ContextTokenEntry;
}

// ============== 路径常量 ==============

const BASE_DIR = resolve(process.env.PI_DATA_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent", "wechat"));

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============== Token 操作 ==============

/**
 * 获取账号的 token.json 路径
 */
function getTokenPath(accountId: string): string {
  return join(BASE_DIR, "accounts", accountId, "token.json");
}

/**
 * 保存登录凭证
 */
export async function saveToken(accountId: string, token: WechatToken): Promise<void> {
  ensureDir(join(BASE_DIR, "accounts", accountId));
  const path = getTokenPath(accountId);
  writeFileSync(path, JSON.stringify(token, null, 2), "utf-8");
  // 设置为用户可读写（600）
  chmodSync(path, 0o600);
  logger.info(`Token saved for account: ${accountId}`);
}

/**
 * 加载登录凭证
 */
export async function loadToken(accountId: string): Promise<WechatToken | null> {
  const path = getTokenPath(accountId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as WechatToken;
  } catch (err) {
    logger.error(`Failed to load token for account ${accountId}: ${String(err)}`);
    return null;
  }
}

/**
 * 删除登录凭证
 */
export async function deleteToken(accountId: string): Promise<void> {
  const path = getTokenPath(accountId);
  if (existsSync(path)) {
    // 使用 fs 删除文件
    const { unlinkSync } = require("node:fs");
    unlinkSync(path);
    logger.info(`Token deleted for account: ${accountId}`);
  }
}

// ============== Account Info 操作 ==============

/**
 * 获取 accounts.json 路径
 */
function getAccountsIndexPath(): string {
  return join(BASE_DIR, "accounts.json");
}

/**
 * 获取所有已注册账号列表
 */
export async function listAccounts(): Promise<AccountInfo[]> {
  const path = getAccountsIndexPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as AccountInfo[];
  } catch (err) {
    logger.error(`Failed to load accounts index: ${String(err)}`);
    return [];
  }
}

/**
 * 保存账号信息到 index
 */
export async function saveAccountIndex(accounts: AccountInfo[]): Promise<void> {
  ensureDir(BASE_DIR);
  const path = getAccountsIndexPath();
  writeFileSync(path, JSON.stringify(accounts, null, 2), "utf-8");
}

/**
 * 添加或更新账号
 */
export async function upsertAccount(info: AccountInfo): Promise<void> {
  const accounts = await listAccounts();
  const idx = accounts.findIndex((a) => a.accountId === info.accountId);
  if (idx >= 0) {
    accounts[idx] = info;
  } else {
    accounts.push(info);
  }
  await saveAccountIndex(accounts);
}

/**
 * 从 index 中移除账号
 */
export async function removeAccount(accountId: string): Promise<void> {
  const accounts = await listAccounts();
  const filtered = accounts.filter((a) => a.accountId !== accountId);
  await saveAccountIndex(filtered);
}

// ============== Context Tokens 操作 ==============

/**
 * 获取 context-tokens.json 路径
 */
function getContextTokensPath(accountId: string): string {
  return join(BASE_DIR, "accounts", accountId, "context-tokens.json");
}

/**
 * 保存所有用户的 context tokens
 */
export async function saveContextTokens(accountId: string, tokens: ContextTokens): Promise<void> {
  ensureDir(join(BASE_DIR, "accounts", accountId));
  const path = getContextTokensPath(accountId);
  writeFileSync(path, JSON.stringify(tokens, null, 2), "utf-8");
  logger.debug(`Context tokens saved for account: ${accountId}, ${Object.keys(tokens).length} users`);
}

/**
 * 加载所有用户的 context tokens
 */
export async function loadContextTokens(accountId: string): Promise<ContextTokens> {
  const path = getContextTokensPath(accountId);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as ContextTokens;
  } catch (err) {
    logger.error(`Failed to load context tokens for account ${accountId}: ${String(err)}`);
    return {};
  }
}

/**
 * 保存单个用户的 context token
 */
export async function saveContextToken(
  accountId: string,
  userId: string,
  entry: ContextTokenEntry
): Promise<void> {
  const tokens = await loadContextTokens(accountId);
  tokens[userId] = entry;
  await saveContextTokens(accountId, tokens);
}

/**
 * 加载单个用户的 context token
 */
export async function loadContextToken(
  accountId: string,
  userId: string
): Promise<ContextTokenEntry | null> {
  const tokens = await loadContextTokens(accountId);
  return tokens[userId] ?? null;
}

// ============== Sync Cursor 操作 ==============

/**
 * 获取 sync.json 路径
 */
function getSyncCursorPath(accountId: string): string {
  return join(BASE_DIR, "accounts", accountId, "sync.json");
}

export interface SyncState {
  syncCursor: string;
  lastSyncAt: number;
}

/**
 * 保存 sync cursor
 */
export async function saveSyncCursor(accountId: string, cursor: string): Promise<void> {
  ensureDir(join(BASE_DIR, "accounts", accountId));
  const path = getSyncCursorPath(accountId);
  const state: SyncState = {
    syncCursor: cursor,
    lastSyncAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * 加载 sync cursor
 */
export async function loadSyncCursor(accountId: string): Promise<string | null> {
  const path = getSyncCursorPath(accountId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    const state = JSON.parse(content) as SyncState;
    return state.syncCursor;
  } catch (err) {
    logger.error(`Failed to load sync cursor for account ${accountId}: ${String(err)}`);
    return null;
  }
}

// ============== 便捷函数 ==============

/**
 * 检查是否已登录（是否存在有效的 token）
 */
export async function isLoggedIn(accountId?: string): Promise<boolean> {
  if (accountId) {
    const token = await loadToken(accountId);
    return token !== null;
  }
  // 如果没指定账号，检查是否有任何已登录账号
  const accounts = await listAccounts();
  return accounts.length > 0;
}

/**
 * 获取已登录账号的 token（如果有）
 * 优先返回最近登录的账号
 */
export async function getDefaultAccountToken(): Promise<WechatToken | null> {
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    return null;
  }
  // 按登录时间排序，返回最新的
  accounts.sort((a, b) => b.loginAt - a.loginAt);
  return await loadToken(accounts[0].accountId);
}
