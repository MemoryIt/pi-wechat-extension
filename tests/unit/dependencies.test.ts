/**
 * tests/unit/dependencies.test.ts
 *
 * 覆盖缺陷 D22：package.json 依赖清单与核心文件的 import 不一致
 * （index.ts 引入 @sinclair/typebox，但 dependencies 里只有 zod）。
 *
 * 仅读取仓库根 package.json 与 4 个核心文件，不读底层模块。
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../setup/mocks";

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const CORE_FILES = ["index.ts", "wechat.ts", "config.ts", "storage/state.ts"];

function collectBareImports(): string[] {
  const specifiers = new Set<string>();
  for (const file of CORE_FILES) {
    const source = readFileSync(join(REPO_ROOT, file), "utf-8");
    const patterns = [/from\s+["']([^"']+)["']/g, /import\s+["']([^"']+)["']/g];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        specifiers.add(spec);
      }
    }
  }
  return [...specifiers].sort();
}

const bareImports = collectBareImports();

// ---------------------------------------------------------------------------
// D22-a：@sinclair/typebox 被核心文件 import，却未声明
// ---------------------------------------------------------------------------

test("D22 证伪：index.ts 引入了 @sinclair/typebox，但 package.json 未声明", () => {
  expect(bareImports).toContain("@sinclair/typebox");
  expect(pkg.dependencies?.["@sinclair/typebox"]).toBeUndefined();
});

test.failing("D22 目标：核心文件用到的裸包都应在 package.json 中声明", () => {
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const missing = bareImports.filter((spec) => declared[spec] === undefined);
  expect(missing).toEqual([]);
});

test.failing("D22 目标：@sinclair/typebox 应声明在 dependencies", () => {
  expect(pkg.dependencies?.["@sinclair/typebox"]).toBeDefined();
});
