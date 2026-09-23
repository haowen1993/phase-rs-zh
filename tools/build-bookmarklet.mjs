#!/usr/bin/env node
/**
 * 生成书签小工具（bookmarklet）三件套：
 *
 *     node tools/build-bookmarklet.mjs
 *
 *   dist/phase-rs-zh.bookmarklet.js   压缩后的代码本体（供人审阅/比对）
 *   dist/phase-rs-zh.bookmarklet.txt  可直接粘贴为书签地址的 javascript: 一行
 *   dist/install.html           拖拽安装页（Safari 上最省事的安装方式）
 *
 * 为什么必须压缩，而不是直接把 src/content.js 塞进 javascript: URL：
 *
 *  1. 书签地址不能含真实换行，而源码里到处是 `//` 行注释——把换行换成空格，那些
 *     注释就会把它后面的代码整段吃掉。所以必须由真正的解析器去注释，不能用正则
 *     去猜（源码里有大量含 `//` 的 URL 字符串，正则一删就完蛋）。
 *  2. `--charset=ascii` 让 esbuild 把非 ASCII 转义成 \uXXXX，书签正文变成纯 ASCII，
 *     避免中文注释在不同浏览器里被百分号编码折腾出差异。
 *
 * esbuild 从仓库 `client/` 已经装好的依赖里找（pnpm 的 .pnpm 目录下按平台存放
 * 原生二进制）。找不到就明确失败——产物已提交在 dist/，日常并不需要重新生成。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = join(ROOT, "..");

const SOURCE_PATH = join(ROOT, "src", "content.js");
const OUT_DIR = join(ROOT, "dist");
const OUT_JS = join(OUT_DIR, "phase-rs-zh.bookmarklet.js");
const OUT_TXT = join(OUT_DIR, "phase-rs-zh.bookmarklet.txt");
const OUT_HTML = join(OUT_DIR, "install.html");

/**
 * 找到 esbuild 可执行文件，按优先级：
 *
 *   1. 环境变量 `ESBUILD_BIN`——把这个书签目录搬出 phase.rs 仓库之后，用这个指过去。
 *   2. `PATH` 上任意一个 esbuild（`brew install esbuild` / `npm i -g esbuild` 都行）。
 *   3. 本仓库 `client/` 里已经装好的。pnpm 把平台包放在
 *      `.pnpm/@esbuild+<platform>@<version>/node_modules/@esbuild/<platform>/bin/esbuild`，
 *      而 `.bin/` 里的垫片在本机实测是坏的（会被当成 JS 解析），所以直接按包目录找
 *      原生可执行文件。
 *
 * 找不到就明确失败——产物已提交在 dist/，日常并不需要重新生成。
 */
function findEsbuild() {
  const override = process.env.ESBUILD_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`ESBUILD_BIN 指向的文件不存在：${override}`);
    }
    return override;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "esbuild");
    if (existsSync(candidate)) return candidate;
  }

  const pnpm = join(REPO, "client", "node_modules", ".pnpm");
  if (!existsSync(pnpm)) return null;
  for (const entry of readdirSync(pnpm)) {
    if (!entry.startsWith("@esbuild+")) continue;
    const platformRoot = join(pnpm, entry, "node_modules", "@esbuild");
    if (!existsSync(platformRoot)) continue;
    for (const platform of readdirSync(platformRoot)) {
      const binary = join(platformRoot, platform, "bin", "esbuild");
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

function minify(source) {
  const esbuild = findEsbuild();
  if (!esbuild) {
    throw new Error(
      "找不到 esbuild。产物已提交在 dist/，通常不需要重新生成；"
      + "确实要重新生成的话，先在 client/ 里跑 `pnpm install`。",
    );
  }
  return execFileSync(
    esbuild,
    ["--minify", "--target=es2020", "--charset=ascii", "--log-level=warning"],
    { input: source, encoding: "utf8" },
  ).trim();
}

/** 书签地址 = `javascript:` + 百分号编码后的正文。 */
function toBookmarkletUrl(code) {
  return `javascript:${encodeURIComponent(code)}`;
}

function installPage(bookmarkletUrl, codeHash, codeBytes) {
  // 正文已由 encodeURIComponent 编码，不含引号/尖括号/&，可安全放进 HTML 属性。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>安装 phase-rs-zh（Phase 中文卡图）书签</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 -apple-system, "PingFang SC", system-ui, sans-serif;
         max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; }
  .drag { display: inline-block; margin: 1.25rem 0; padding: .7rem 1.4rem;
          border-radius: .6rem; background: #c8102e; color: #ffd400; font-weight: 700;
          text-decoration: none; border: 2px solid #8f0b20; }
  ol { padding-left: 1.4rem; } li { margin: .4rem 0; }
  code { background: rgba(127,127,127,.16); padding: .1rem .35rem; border-radius: .25rem; }
  textarea { width: 100%; height: 7rem; font: 12px/1.5 ui-monospace, monospace; }
  .note { background: rgba(200,16,46,.08); border-left: 3px solid #c8102e;
          padding: .7rem 1rem; border-radius: .3rem; }
  footer { margin-top: 2rem; font-size: .85rem; opacity: .7; }
</style>
</head>
<body>
<h1>安装 phase-rs-zh</h1>
<p>把 <a href="https://phase-rs.dev">phase.rs</a> 网页版的卡图换成大学院废墟（sbwsz.com）的简体中文图。
   不用装扩展，不用装脚本管理器。</p>

<p>把下面这个按钮 <strong>拖到书签栏</strong>（在多数浏览器里 <code>⌥⌘B</code> 或
   <code>Ctrl+Shift+B</code> 可以显示书签栏）。拖不动就右键它，选「添加到书签」。</p>

<p><a class="drag" href="${bookmarkletUrl}">中文卡图</a></p>

<ol>
  <li>打开 <code>https://phase-rs.dev</code>，进入牌桌或牌组。</li>
  <li><strong>点一下书签栏里的「中文卡图」</strong>，卡图就会变成大学院废墟的简体中文图。</li>
</ol>

<p class="note">
  <strong>每次重新加载页面后都要再点一下。</strong>
  页面内的跳转（换牌桌、翻牌组）不需要——脚本一旦注入就管到本次加载结束。
  这就是「一个书签、零安装」的代价。
</p>

<p>换浏览器或换设备不用重新装：在新浏览器里新建一个书签，把它的<strong>地址</strong>
   整段替换成下面这行即可。</p>

<h2>备用：手动粘贴地址</h2>
<p>如果拖拽和右键都不灵，就新建一个书签，把它的<strong>地址</strong>整段替换成下面这行：</p>
<textarea readonly onclick="this.select()">${bookmarkletUrl}</textarea>

<footer>
  phase-rs-zh · 正文 ${codeBytes} 字节（百分号编码后 ${bookmarkletUrl.length} 字节）·
  由 <code>src/content.js</code> 经 esbuild 压缩生成 ·
  内容 sha256: <code>${codeHash}</code>
</footer>
</body>
</html>
`;
}

const source = readFileSync(SOURCE_PATH, "utf8");
const code = minify(source);
const bookmarkletUrl = toBookmarkletUrl(code);
const codeHash = createHash("sha256").update(source).digest("hex").slice(0, 12);

// 纯 ASCII 且不含任何控制字符，是书签能安全放进一个 URL 的硬前提。生成时就断言，
// 别等用户装完才发现。`src/content.js` 里刻意用码点表而不是 "\t"/"\n" 字面量做空白
// 比较，就是为了守住这条：压缩器会把转义字面量改写成真实控制字符。
if (!/^[\x20-\x7e]*$/.test(code)) throw new Error("压缩后的正文含非 ASCII 或控制字符");
if (code.includes("\n")) throw new Error("压缩后的正文含换行");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_JS,
  `${code}\n// source: src/content.js\n// source sha256 (前 12 位): ${codeHash}\n`,
  "utf8",
);
writeFileSync(OUT_TXT, bookmarkletUrl, "utf8");
writeFileSync(OUT_HTML, installPage(bookmarkletUrl, codeHash, Buffer.byteLength(code, "utf8")), "utf8");

console.log(`正文 ${Buffer.byteLength(code, "utf8")} 字节 → 书签地址 ${bookmarkletUrl.length} 字节`);
console.log(`内容 sha256 前 12 位: ${codeHash}`);
for (const path of [OUT_JS, OUT_TXT, OUT_HTML]) {
  console.log(`  已生成 ${path.replace(`${REPO}/`, "")}`);
}
