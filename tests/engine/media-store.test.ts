/**
 * tests/engine/media-store.test.ts
 *
 * media-store.ts 单测（真实 MediaStore + mock media/media-download + 临时目录）：
 * - save 扩展名优先级（originalFilename > contentType > 魔数 > bin）
 * - detectFileType 各签名
 * - createSaveCallback 落盘
 * - downloadAll 收集路径 / 单项失败不影响其它
 */
import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installBaseMocks, repoPath } from "../setup/mocks";

const downloadMock = {
  downloadMediaFromItem: mock(async (_item: unknown, _opts: unknown) => ({})),
};

installBaseMocks();
mock.module(repoPath("media", "media-download.js"), () => downloadMock);
mock.module(repoPath("media", "media-download.ts"), () => downloadMock);

const {
  MediaStore,
  detectFileType,
  CONTENT_TYPE_EXT_MAP,
  getCurrentWeekFolder,
  getISOWeek,
} = await import("../../media-store.js");
const config = await import("../../config.js");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const rootDir = mkdtempSync(path.join(tmpdir(), "media-store-test-"));

function makeStore(basePath = rootDir): InstanceType<typeof MediaStore> {
  return new MediaStore({ getBasePath: () => basePath, log: () => {}, errLog: () => {} });
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(rootDir, prefix));
}

beforeEach(() => {
  downloadMock.downloadMediaFromItem.mockReset();
  downloadMock.downloadMediaFromItem.mockImplementation(async () => ({}));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

test("save：PNG 魔数、无 contentType/filename → {basePath}/{YYWW}/{timestamp}_{uuid8}.png", () => {
  const dir = tempDir("save-");
  const saved = makeStore(dir).save(PNG_MAGIC);

  const rel = path.relative(dir, saved);
  const parts = rel.split(path.sep);
  const week = getCurrentWeekFolder();

  expect(parts[0]).toBe(week);
  expect(week).toMatch(/^\d{4}$/);
  expect(parts[1]).toMatch(/^\d{15}_[0-9a-f]{8}\.png$/);
  expect(existsSync(saved)).toBe(true);
  expect(readFileSync(saved)).toEqual(PNG_MAGIC);
});

test("save：扩展名优先级 originalFilename > contentType > 魔数 > bin", () => {
  const dir = tempDir("prio-");
  const store = makeStore(dir);

  // 魔数 → png
  expect(store.save(PNG_MAGIC).endsWith(".png")).toBe(true);
  // contentType 覆盖魔数
  expect(store.save(PNG_MAGIC, "image/jpeg").endsWith(".jpg")).toBe(true);
  // originalFilename 覆盖 contentType
  expect(store.save(PNG_MAGIC, "image/jpeg", "photo.webp").endsWith(".webp")).toBe(true);
  // 未知 contentType → bin
  expect(store.save(PNG_MAGIC, "application/octet-stream").endsWith(".bin")).toBe(true);
  // 未知魔数 → bin
  expect(store.save(Buffer.from([0x00, 0x01, 0x02, 0x03])).endsWith(".bin")).toBe(true);
});

test("save：未知 contentType 但魔数已知时仍优先 contentType 映射（未知→bin）", () => {
  const dir = tempDir("prio2-");
  const store = makeStore(dir);
  // 显式 contentType 未知时按现逻辑取 bin，不再回退魔数
  const saved = store.save(PNG_MAGIC, "image/unknown");
  expect(saved.endsWith(".bin")).toBe(true);
});

test("createSaveCallback：落盘并返回 { path }", async () => {
  const dir = tempDir("cb-");
  const cb = makeStore(dir).createSaveCallback();
  const { path: saved } = await cb(PNG_MAGIC, "image/png");
  expect(saved.endsWith(".png")).toBe(true);
  expect(existsSync(saved)).toBe(true);
});

test("MediaStore 默认 getBasePath 使用 getMediaStoragePath()", () => {
  const dir = tempDir("env-");
  process.env.WECHAT_MEDIA_PATH = dir;
  config.clearConfigCache();
  try {
    const saved = new MediaStore({ log: () => {}, errLog: () => {} }).save(PNG_MAGIC);
    expect(saved.startsWith(dir + path.sep)).toBe(true);
  } finally {
    delete process.env.WECHAT_MEDIA_PATH;
    config.clearConfigCache();
  }
});

// ---------------------------------------------------------------------------
// detectFileType
// ---------------------------------------------------------------------------

test("detectFileType：jpg/png/gif/webp/bmp/mp4/silk/ogg/未知", () => {
  expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
  expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
  expect(detectFileType(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBe("gif");
  expect(
    detectFileType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50])),
  ).toBe("webp");
  expect(detectFileType(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBe("bmp");
  expect(detectFileType(Buffer.from([0x66, 0x74, 0x79, 0x70]))).toBe("mp4");
  expect(detectFileType(Buffer.from([0x02, 0x00, 0x00, 0x00]))).toBe("silk");
  expect(detectFileType(Buffer.from([0x4f, 0x67, 0x67, 0x53]))).toBe("ogg");
  expect(detectFileType(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  expect(detectFileType(Buffer.from([0x89]))).toBeNull();
});

test("CONTENT_TYPE_EXT_MAP：常见 MIME 映射", () => {
  expect(CONTENT_TYPE_EXT_MAP["image/png"]).toBe("png");
  expect(CONTENT_TYPE_EXT_MAP["audio/wav"]).toBe("wav");
  expect(CONTENT_TYPE_EXT_MAP["video/quicktime"]).toBe("mov");
  expect(CONTENT_TYPE_EXT_MAP["image/jpeg"]).toBe("jpg");
});

test("getISOWeek / getCurrentWeekFolder：周数合理", () => {
  // 2026-01-01 属于 ISO 2026-W01
  expect(getISOWeek(new Date(2026, 0, 1))).toBe(1);
  expect(getCurrentWeekFolder()).toMatch(/^\d{4}$/);
});

// ---------------------------------------------------------------------------
// downloadAll
// ---------------------------------------------------------------------------

test("downloadAll：多 item 收集路径，TEXT 跳过；cdnBaseUrl/label 透传", async () => {
  const store = makeStore();
  downloadMock.downloadMediaFromItem.mockImplementation(async (item: unknown) => {
    const type = (item as { type: number }).type;
    if (type === 2) return { decryptedPicPath: "/tmp/a.png" };
    if (type === 3) return { decryptedVoicePath: "/tmp/a.wav" };
    if (type === 5) return { decryptedVideoPath: "/tmp/a.mp4" };
    return {};
  });

  const paths = await store.downloadAll(
    [{ type: 1 }, { type: 2 }, { type: 3 }, { type: 4 }, { type: 5 }],
    "https://cdn.example.com",
  );

  expect(paths).toEqual(["/tmp/a.png", "/tmp/a.wav", "/tmp/a.mp4"]);
  // TEXT(1) 不调用底层
  expect(downloadMock.downloadMediaFromItem).toHaveBeenCalledTimes(4);
  const deps = downloadMock.downloadMediaFromItem.mock.calls[0][1] as {
    cdnBaseUrl: string;
    label: string;
  };
  expect(deps.cdnBaseUrl).toBe("https://cdn.example.com");
  expect(deps.label).toBe("media-2");
});

test("downloadAll：自定义 labelPrefix", async () => {
  const store = makeStore();
  await store.downloadAll([{ type: 2 }], "https://cdn.example.com", "custom");
  const deps = downloadMock.downloadMediaFromItem.mock.calls[0][1] as { label: string };
  expect(deps.label).toBe("custom-2");
});

test("downloadAll：单项抛错记录 errLog 且不影响其它 item", async () => {
  const errors: unknown[] = [];
  const store = new MediaStore({
    getBasePath: () => rootDir,
    log: () => {},
    errLog: (...a: unknown[]) => errors.push(a),
  });

  downloadMock.downloadMediaFromItem.mockImplementation(async (item: unknown) => {
    const type = (item as { type: number }).type;
    if (type === 4) throw new Error("boom");
    if (type === 2) return { decryptedPicPath: "/tmp/a.png" };
    if (type === 3) return { decryptedVoicePath: "/tmp/a.wav" };
    return {};
  });

  const paths = await store.downloadAll([{ type: 2 }, { type: 4 }, { type: 3 }], "cdn");
  expect(paths).toEqual(["/tmp/a.png", "/tmp/a.wav"]);
  expect(errors.length).toBe(1);
  expect(String(errors[0])).toContain("boom");
});
