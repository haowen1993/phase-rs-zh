#!/usr/bin/env node
/**
 * 用 phase.rs 自己的数据文件，逐个验证插件的解析器认不认。
 *
 *     node tools/check-app-data-coverage.mjs          # 在 phase.rs 仓库根目录跑
 *
 * 为什么值得留着：`check-live.mjs` 守的是大学院废墟那一侧的 URL 形状，这个守的是
 * **应用这一侧**。应用哪天新增一种卡图尺寸或换一个 CDN host，插件会静默漏改那批图
 * ——界面不报错，只是那些卡还是英文。这个脚本把「应用能产出的每一种卡图 URL」都过
 * 一遍，漏改会立刻变成非零退出码。
 *
 * 需要仓库里已生成的数据文件（gitignored，先跑 cards/scryfall 数据生成脚本）：
 *   client/public/scryfall-data.json
 *   client/public/scryfall-token-images.json
 *   client/public/scryfall-printings.json
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const EXTENSION_SOURCE = new URL("../src/content.js", import.meta.url);
vm.runInThisContext(readFileSync(EXTENSION_SOURCE, "utf8"), { filename: "content.js" });

const { parseArtUrl, rewriteUrl } = globalThis.__phaseZhCardArt;

const DATA_FILES = [
  "client/public/scryfall-data.json",
  "client/public/scryfall-token-images.json",
  "client/public/scryfall-printings.json",
];

/** 把嵌套结构里所有看起来像 URL 的字符串收集出来。 */
function collectUrls(value, out) {
  if (typeof value === "string") {
    if (value.includes("://")) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, out);
  }
}

let total = 0;
let parsed = 0;
let ignored = 0;
const missed = new Map();
const ignoredHosts = new Map();

for (const file of DATA_FILES) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) {
    console.log(`· 跳过 ${file}（未生成）`);
    continue;
  }

  const urls = [];
  collectUrls(JSON.parse(readFileSync(path, "utf8")), urls);

  let fileMissed = 0;
  for (const url of urls) {
    total += 1;
    if (parseArtUrl(url)) {
      parsed += 1;
      continue;
    }
    // 不是卡图的 URL（牌背、占位图、系列图标…）属于预期忽略；只有
    // cards.scryfall.io 上的卡图 URL 漏掉才是缺陷。
    const host = /^https?:\/\/([^/?#]+)/.exec(url)?.[1] ?? "(relative)";
    if (host !== "cards.scryfall.io") {
      ignored += 1;
      ignoredHosts.set(host, (ignoredHosts.get(host) ?? 0) + 1);
      continue;
    }
    fileMissed += 1;
    const shape = url.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "<uuid>");
    missed.set(shape, (missed.get(shape) ?? 0) + 1);
  }

  console.log(
    `${file.padEnd(45)} URL=${String(urls.length).padStart(7)}`
    + `  识别=${String(urls.length - fileMissed).padStart(7)}`
    + `  漏识别=${String(fileMissed).padStart(5)}`,
  );
}

if (total === 0) {
  console.error("没有可检查的数据文件：请先生成 client/public/scryfall-*.json。");
  process.exit(2);
}

const missedTotal = [...missed.values()].reduce((sum, count) => sum + count, 0);
console.log(
  `\n合计 ${total} 个 URL：识别 ${parsed}，按设计忽略 ${ignored}（非 cards.scryfall.io），漏识别 ${missedTotal}`,
);
if (ignoredHosts.size > 0) {
  console.log("被忽略的 host：" + [...ignoredHosts].map(([host, count]) => `${host}(${count})`).join(", "));
}

if (missedTotal > 0) {
  console.error("\n以下 cards.scryfall.io URL 形状未被插件识别（这些卡图将保持英文）：");
  for (const [shape, count] of [...missed].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.error(`  ${String(count).padStart(7)}  ${shape}`);
  }
  process.exit(1);
}

// 顺带打印一条真实改写，方便肉眼确认目标 URL 的形状。
const dataPath = resolve(process.cwd(), DATA_FILES[0]);
if (existsSync(dataPath)) {
  const map = JSON.parse(readFileSync(dataPath, "utf8"));
  const entry = Object.values(map).find((value) => value?.faces?.[0]?.normal);
  if (entry) {
    const { normal, art_crop: artCrop } = entry.faces[0];
    console.log(`\n样例：\n  ${normal}\n  → ${rewriteUrl(normal)}`);
    if (artCrop) console.log(`  ${artCrop}\n  → ${rewriteUrl(artCrop)}`);
  }
}

console.log("\n应用能产出的每一种卡图 URL 都能被识别并改写。");
