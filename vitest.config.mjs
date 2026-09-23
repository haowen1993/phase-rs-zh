import { defineConfig } from "vitest/config";

/**
 * DOM 装配测试专用的 vitest 配置。
 *
 * 只有 `test/assembly.dom.mjs` 走 vitest（它需要真实 DOM）。零依赖的那套单测在
 * `test/content.test.mjs`，由 `node --test` 跑，**不要**把它并进 vitest——那会让
 * 纯逻辑测试也依赖 node_modules。
 *
 * include 刻意写成 `*.dom.mjs` 而不是 vitest 默认的 `*.test.mjs`：`node --test test/`
 * 只收集 `*.test.mjs`，所以这样命名能让两套测试互不干扰（实测确认）。
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/*.dom.mjs"],
  },
});
