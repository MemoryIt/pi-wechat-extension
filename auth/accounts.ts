/**
 * Simplified accounts module for pi-wechat-extension
 * Only provides loadConfigRouteTag for API headers
 */

/**
 * Load SKRouteTag from config (simplified - returns undefined)
 * In full implementation, this would read from openclaw.json
 */
export function loadConfigRouteTag(_accountId?: string): string | undefined {
  return undefined;
}

// Stub implementations for other functions that might be imported
export function saveWeixinAccount(_id: string, _data: unknown): void {
  // Stub - not needed for login flow
}

export function loadWeixinAccount(_id: string): unknown {
  // Stub - not needed for login flow
  return undefined;
}

export function listWeixinAccountIds(): string[] {
  return [];
}

export function registerWeixinAccountId(_id: string): void {
  // Stub
}

export function resolveWeixinAccount(_cfg: unknown, _id: string | null): unknown {
  // Stub
  return null;
}

export function triggerWeixinChannelReload(): void {
  // Stub
}

export function clearStaleAccountsForUserId(_id: string, _userId: string, _clearFn: Function): void {
  // Stub
}

export function clearContextTokensForAccount(_accountId: string): void {
  // Stub
}

export function findAccountIdsByContextToken(_ids: string[], _to: string): string[] {
  return [];
}

export function restoreContextTokens(_accountId: string): void {
  // Stub
}
