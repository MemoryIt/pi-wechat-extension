/**
 * Ambient type declarations for the optional `silk-wasm` dependency.
 *
 * `silk-wasm` is loaded lazily at runtime (dynamic import) and is intentionally
 * not a hard dependency of this package. These declarations only describe the
 * subset of the API used by `media/silk-transcode.ts`.
 */
declare module "silk-wasm" {
  interface DecodeResult {
    /** Raw PCM samples (pcm_s16le). */
    data: Uint8Array;
    /** Duration of the decoded audio in milliseconds. */
    duration: number;
  }

  /**
   * Decode a SILK audio buffer into PCM.
   *
   * @param buf SILK audio bytes.
   * @param sampleRate Target sample rate in Hz.
   */
  export function decode(buf: Uint8Array | Buffer, sampleRate: number): Promise<DecodeResult>;
}
