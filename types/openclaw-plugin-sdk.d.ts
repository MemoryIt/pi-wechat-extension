/**
 * Ambient type declarations for the private, type-only package
 * `openclaw/plugin-sdk/reply-runtime`.
 *
 * The runtime never imports this package; `messaging/send.ts` only uses its
 * `ReplyPayload` type. The declaration is intentionally loose so that it keeps
 * compiling against upstream changes that are irrelevant to this subset.
 */
declare module "openclaw/plugin-sdk/reply-runtime" {
  export interface ReplyPayload {
    /** Optional text content of the reply. */
    text?: string;
    [key: string]: unknown;
  }
}
