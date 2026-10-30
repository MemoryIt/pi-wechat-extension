/**
 * storage/state.ts
 * 
 * 持久化存储：登录凭证、context tokens、sync cursor
 *
 * 当前为单用户模式：底部 getSingleUser* 是单用户便捷函数；
 * 其余多用户相关导出（listAccounts / loadContextTokens 等）属迁移遗留，暂保留。
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

import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, unlinkSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { resolveStateDir } from "../shared/paths.js";
import { logger } from "../shared/file-logger.js";

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

/** WeChat 插件数据存储目录: ~/.pi/agent/wechat */
const BASE_DIR = resolveStateDir();

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============== 原子写入 & 串行化 ==============

/**
 * 按文件路径串行化「读-改-写」操作，避免并发写互相覆盖造成丢写。
 * 同一路径上的操作按调用顺序依次执行，不同路径互不阻塞。
 */
const mutationQueues = new Map<string, Promise<unknown>>();

function withPathQueue<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = mutationQueues.get(path) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  mutationQueues.set(path, tail);
  void tail.then(() => {
    if (mutationQueues.get(path) === tail) {
      mutationQueues.delete(path);
    }
  });
  return result;
}

/**
 * 原子写 JSON：写入同目录下的临时文件后 renameSync 覆盖目标文件，
 * 保证任何时刻目标文件要么是旧内容、要么是完整的新内容，不会出现半截文件。
 */
function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理临时文件失败时忽略，避免掩盖原始错误
    }
    throw err;
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
  const path = getTokenPath(accountId);
  await withPathQueue(path, () => {
    // 原子写入，并设置为用户可读写（600）
    writeJsonAtomic(path, token, 0o600);
  });
  logger.info(`Token saved for account: ${accountId}`);
}

/**
 * 同步读取登录凭证（内部使用，读操作不需串行化：原子写保证读到完整文件）
 */
function readTokenRaw(accountId: string): WechatToken | null {
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
 * 加载登录凭证
 */
export async function loadToken(accountId: string): Promise<WechatToken | null> {
  return readTokenRaw(accountId);
}

/**
 * 删除登录凭证
 */
export async function deleteToken(accountId: string): Promise<void> {
  const path = getTokenPath(accountId);
  if (existsSync(path)) {
    unlinkSync(path);
    logger.info(`Token deleted for account: ${accountId}`);
  }
}

/**
 * 删除整个账号目录（包括 token.json、context-tokens.json、sync.json 等所有文件）
 */
export async function deleteAccountData(accountId: string): Promise<void> {
  const accountDir = join(BASE_DIR, "accounts", accountId);
  if (existsSync(accountDir)) {
    rmSync(accountDir, { recursive: true, force: true });
    logger.info(`Account data deleted for: ${accountId}`);
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
 * 同步读取账号索引（内部使用）
 */
function readAccountsRaw(): AccountInfo[] {
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
 * 获取所有已注册账号列表
 */
export async function listAccounts(): Promise<AccountInfo[]> {
  return readAccountsRaw();
}

/**
 * 保存账号信息到 index
 */
export async function saveAccountIndex(accounts: AccountInfo[]): Promise<void> {
  const path = getAccountsIndexPath();
  await withPathQueue(path, () => {
    writeJsonAtomic(path, accounts);
  });
}

/**
 * 添加或更新账号
 */
export async function upsertAccount(info: AccountInfo): Promise<void> {
  const path = getAccountsIndexPath();
  await withPathQueue(path, () => {
    const accounts = readAccountsRaw();
    const idx = accounts.findIndex((a) => a.accountId === info.accountId);
    if (idx >= 0) {
      accounts[idx] = info;
    } else {
      accounts.push(info);
    }
    writeJsonAtomic(path, accounts);
  });
}

/**
 * 从 index 中移除账号
 */
export async function removeAccount(accountId: string): Promise<void> {
  const path = getAccountsIndexPath();
  await withPathQueue(path, () => {
    const accounts = readAccountsRaw();
    const filtered = accounts.filter((a) => a.accountId !== accountId);
    writeJsonAtomic(path, filtered);
  });
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
  const path = getContextTokensPath(accountId);
  await withPathQueue(path, () => {
    writeJsonAtomic(path, tokens);
  });
  logger.debug(`Context tokens saved for account: ${accountId}, ${Object.keys(tokens).length} users`);
}

/**
 * 同步读取 context tokens（内部使用）
 */
function readContextTokensRaw(accountId: string): ContextTokens {
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
 * 加载所有用户的 context tokens
 */
export async function loadContextTokens(accountId: string): Promise<ContextTokens> {
  return readContextTokensRaw(accountId);
}

/**
 * 保存单个用户的 context token
 *
 * 读-改-写整个过程在同一路径的串行队列内执行，避免并发调用互相覆盖。
 */
export async function saveContextToken(
  accountId: string,
  userId: string,
  entry: ContextTokenEntry
): Promise<void> {
  const path = getContextTokensPath(accountId);
  await withPathQueue(path, () => {
    const tokens = readContextTokensRaw(accountId);
    tokens[userId] = entry;
    writeJsonAtomic(path, tokens);
  });
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
  const path = getSyncCursorPath(accountId);
  const state: SyncState = {
    syncCursor: cursor,
    lastSyncAt: Date.now(),
  };
  await withPathQueue(path, () => {
    writeJsonAtomic(path, state);
  });
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

// ============== 单用户便捷函数 ==============

/**
 * 获取单用户的凭证信息
 * 单用户模式下，直接返回存储的唯一凭证
 * 
 * @returns 单用户凭证，包含 botToken, accountId, userId, baseUrl
 */
export async function getSingleUserCredentials(): Promise<{
  botToken: string;
  accountId: string;
  userId: string;
  baseUrl: string;
} | null> {
  const token = await getDefaultAccountToken();
  if (!token) {
    return null;
  }
  return {
    botToken: token.botToken,
    accountId: token.accountId,
    userId: token.userId,
    baseUrl: token.baseUrl,
  };
}

/**
 * 获取单用户的 contextToken
 * 以 token.json 中的 userId 为准，精确读取该用户对应的 context token，
 * 而不是取 context-tokens.json 里的第一个 key（避免返回其他用户的 token）。
 * 
 * @returns contextToken 或 null
 */
export async function getSingleUserContextToken(): Promise<string | null> {
  const token = await getDefaultAccountToken();
  if (!token) {
    return null;
  }

  const tokens = await loadContextTokens(token.accountId);
  return tokens[token.userId]?.contextToken ?? null;
}

/**
 * 获取单用户的 userId
 * 从 token.json 中读取
 * 
 * @returns userId 或 null
 */
export async function getSingleUserId(): Promise<string | null> {
  const token = await getDefaultAccountToken();
  return token?.userId ?? null;
}
