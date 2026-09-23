/**
 * 纯逻辑单测：URL 解析、层级改写与 srcset 处理。
 *
 * 直接加载 `src/content.js` 本体（不复制一份实现），在 Node 里跑：脚本在没有
 * DOM 时会跳过装配，只把纯函数挂到 `globalThis.__phaseZhCardArt`。
 *
 *     node --test phase-rs-zh/test/
 *
 * 这里断言的全部 URL 形状都是对真实 CDN 实测过的：
 *   https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp  → 200（中文）
 *   https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp   → 200（英文）
 *   https://images.mtgch.com/zhs/art_crop/…                    → 404（无中文裁切图）
 *   https://images.mtgch.com/sf/art_crop/…                     → 200，626x457
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
vm.runInThisContext(SOURCE, { filename: "content.js" });

const {
  version,
  parseArtUrl,
  urlFor,
  rewriteUrl,
  nextTierUrl,
  mapSrcset,
  givenUp,
} = globalThis.__phaseZhCardArt;

/** 真实印刷：2X2 #117 Lightning Bolt（有中文图）。 */
const ID = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
const SHARD_A = "f";
const SHARD_B = "2";

const SCRYFALL = `https://cards.scryfall.io/normal/front/${SHARD_A}/${SHARD_B}/${ID}.jpg?1783921885`;
const SCRYFALL_SMALL = `https://cards.scryfall.io/small/front/${SHARD_A}/${SHARD_B}/${ID}.jpg?1783921885`;
const SCRYFALL_ART = `https://cards.scryfall.io/art_crop/front/${SHARD_A}/${SHARD_B}/${ID}.jpg?1783921885`;
const ZHS = `https://images.mtgch.com/zhs/normal/front/${SHARD_A}/${SHARD_B}/${ID}.webp`;
const SF = `https://images.mtgch.com/sf/normal/front/${SHARD_A}/${SHARD_B}/${ID}.webp`;
const SF_ART = `https://images.mtgch.com/sf/art_crop/front/${SHARD_A}/${SHARD_B}/${ID}.webp`;

test("VERSION 与 package.json 的 version 一致（防漂移）", () => {
  // 控制台那行 `[phase-rs-zh] 已启用 v…` 是用户确认「装的是哪一版」的唯一依据，
  // 也是排障第一步。它读的是 src/content.js 里的 VERSION，而对外版本号记在
  // package.json，两者漂移会让排障直接问错版本。
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, pkg.version, "src/content.js 的 VERSION 与 package.json 不一致");
});

test("parseArtUrl 认出三个来源层级", () => {
  assert.equal(parseArtUrl(SCRYFALL).tier, "scryfall");
  assert.equal(parseArtUrl(ZHS).tier, "zh");
  assert.equal(parseArtUrl(SF).tier, "mtg-en");
  assert.deepEqual(parseArtUrl(SCRYFALL).ref, {
    size: "normal",
    face: "front",
    shardA: SHARD_A,
    shardB: SHARD_B,
    printingId: ID,
  });
});

test("parseArtUrl 保留尺寸与正背面", () => {
  const back = `https://cards.scryfall.io/large/back/${SHARD_A}/${SHARD_B}/${ID}.jpg`;
  assert.deepEqual(parseArtUrl(back).ref, {
    size: "large",
    face: "back",
    shardA: SHARD_A,
    shardB: SHARD_B,
    printingId: ID,
  });
});

test("parseArtUrl 拒绝非卡图与畸形输入", () => {
  const rejected = [
    "",
    "/normal/front/f/2/x.jpg",
    "not a url",
    "http://cards.scryfall.io/normal/front/f/2/" + ID + ".jpg", // 非 https
    `https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg`, // 牌背
    `https://errors.scryfall.com/soon.jpg`,
    `https://svgs.scryfall.io/sets/sos.svg`,
    `https://images.example.com/zhs/normal/front/${SHARD_A}/${SHARD_B}/${ID}.webp`, // 未知 host
    `https://images.mtgch.com/other/normal/front/${SHARD_A}/${SHARD_B}/${ID}.webp`, // 未知前缀
    `https://cards.scryfall.io/normal/front/${SHARD_A}/${SHARD_B}/${ID}.jpg/extra`, // 段数不对
    `https://cards.scryfall.io/normal/front/${SHARD_A}/${SHARD_B}/not-a-uuid.jpg`,
    `https://cards.scryfall.io/thumb/front/${SHARD_A}/${SHARD_B}/${ID}.webp`, // 应用不用的尺寸
    `https://cards.scryfall.io/normal/sideways/${SHARD_A}/${SHARD_B}/${ID}.jpg`, // 非法面
    // uuid 与分片目录不一致：宁可漏改，不可改错
    `https://cards.scryfall.io/normal/front/a/b/${ID}.jpg`,
  ];
  for (const input of rejected) {
    assert.equal(parseArtUrl(input), null, `应拒绝：${input}`);
  }
});

test("parseArtUrl 不接受中文层的 art_crop（该尺寸不存在）", () => {
  assert.equal(
    parseArtUrl(`https://images.mtgch.com/zhs/art_crop/front/${SHARD_A}/${SHARD_B}/${ID}.webp`),
    null,
  );
});

test("rewriteUrl：带卡面的尺寸走中文层", () => {
  assert.equal(rewriteUrl(SCRYFALL), ZHS);
  assert.equal(rewriteUrl(SCRYFALL_SMALL), `https://images.mtgch.com/zhs/small/front/${SHARD_A}/${SHARD_B}/${ID}.webp`);
});

test("rewriteUrl：art_crop 走大学院废墟的英文层", () => {
  assert.equal(rewriteUrl(SCRYFALL_ART), SF_ART);
});

test("rewriteUrl 幂等，且不碰域外 URL", () => {
  assert.equal(rewriteUrl(ZHS), ZHS);
  assert.equal(rewriteUrl(SF), SF);
  assert.equal(rewriteUrl(SF_ART), SF_ART);
  const foreign = `https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg`;
  assert.equal(rewriteUrl(foreign), foreign);
  const pack = "asset:v1:canonical_card:abc";
  assert.equal(rewriteUrl(pack), pack);
});

test("nextTierUrl 逐级下降，最后一级返回 null", () => {
  // 用另一张印刷：退到 Scryfall 层会登记 givenUp（模块级状态），用主印刷会
  // 污染后面所有 rewriteUrl 断言。
  const ladderId = "11bf83bb-c95b-4b4f-9a56-ce7a1816307a";
  const zh = `https://images.mtgch.com/zhs/normal/front/1/1/${ladderId}.webp`;
  const sf = `https://images.mtgch.com/sf/normal/front/1/1/${ladderId}.webp`;
  const scryfall = `https://cards.scryfall.io/normal/front/1/1/${ladderId}.jpg`;

  assert.equal(nextTierUrl(zh), sf);
  assert.equal(nextTierUrl(sf), scryfall);
  assert.equal(nextTierUrl(scryfall), null);
  assert.equal(
    nextTierUrl(`https://images.mtgch.com/sf/art_crop/front/1/1/${ladderId}.webp`),
    `https://cards.scryfall.io/art_crop/front/1/1/${ladderId}.jpg`,
  );
  assert.equal(nextTierUrl("https://example.com/x.jpg"), null);
});

test("退到 Scryfall 层后该图不再被改写回去（防 404 死循环）", () => {
  const loopId = "000d9280-a79a-4f9f-822c-7aaecbff3337";
  const scryfall = `https://cards.scryfall.io/normal/front/0/0/${loopId}.jpg`;
  const zh = `https://images.mtgch.com/zhs/normal/front/0/0/${loopId}.webp`;
  const sf = `https://images.mtgch.com/sf/normal/front/0/0/${loopId}.webp`;

  assert.equal(rewriteUrl(scryfall), zh);
  assert.equal(nextTierUrl(sf), scryfall);
  // 写回 Scryfall URL 会再次经过被补丁的 setAttribute，此时必须原样放过，
  // 否则会立刻被打回中文层，形成 404 → 改写 → 404 的无限循环。
  assert.equal(rewriteUrl(scryfall), scryfall);
  assert.equal(givenUp.has(`${loopId}:normal`), true);
  // 只放弃这一个尺寸：同一张印刷的 small 仍然继续走中文层。
  assert.equal(
    rewriteUrl(`https://cards.scryfall.io/small/front/0/0/${loopId}.jpg`),
    `https://images.mtgch.com/zhs/small/front/0/0/${loopId}.webp`,
  );
});

test("mapSrcset 改写全部候选并保留描述符", () => {
  const srcset = `${SCRYFALL_SMALL} 146w, ${SCRYFALL} 488w`;
  assert.equal(
    mapSrcset(srcset, rewriteUrl),
    `https://images.mtgch.com/zhs/small/front/${SHARD_A}/${SHARD_B}/${ID}.webp 146w, `
    + `${ZHS} 488w`,
  );
});

test("mapSrcset 原样保留不认识的候选", () => {
  const srcset = `data:image/png;base64,AAAA 1x, ${SCRYFALL} 2x`;
  assert.equal(mapSrcset(srcset, rewriteUrl), `data:image/png;base64,AAAA 1x, ${ZHS} 2x`);
});

test("mapSrcset 在缺少描述符与空白时仍按逗号切分", () => {
  const srcset = `${SCRYFALL_SMALL},${SCRYFALL}`;
  assert.equal(
    mapSrcset(srcset, rewriteUrl),
    `https://images.mtgch.com/zhs/small/front/${SHARD_A}/${SHARD_B}/${ID}.webp, ${ZHS}`,
  );
});

test("mapSrcset 无改动时返回原串（避免多余属性写入）", () => {
  const srcset = "data:image/png;base64,AAAA 1x";
  assert.equal(mapSrcset(srcset, rewriteUrl), srcset);
  assert.equal(mapSrcset("", rewriteUrl), "");
  assert.equal(mapSrcset(undefined, rewriteUrl), undefined);
});

test("urlFor 是唯一的 URL 拼装点", () => {
  const ref = parseArtUrl(SCRYFALL).ref;
  assert.equal(urlFor("zh", ref), ZHS);
  assert.equal(urlFor("mtg-en", ref), SF);
  assert.equal(urlFor("scryfall", ref), SCRYFALL.replace("?1783921885", ""));
});

// ────────────────────────────────────────────────────────────────────────────
// 书签小工具（Safari 路线）：格式前提 + 与源码的行为等价
// ────────────────────────────────────────────────────────────────────────────

/**
 * 在干净的 vm 沙箱里加载一份代码，取回它挂出的 API。
 *
 * 必须用沙箱而不是 `runInThisContext`：书签正文与 `src/content.js` 各自有独立的
 * 「放弃」集合。同一个全局里先后加载两份，前者的状态会污染后者的结果，比对就失去
 * 意义。沙箱还顺带证明了两份代码在完全没有 DOM 时也能安全加载（只挂 API、不装配）。
 */
function loadApi(code, filename) {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename });
  return sandbox.__phaseZhCardArt;
}

test("书签小工具：格式前提（单行、纯 ASCII、无控制字符、可解析）", () => {
  const url = readFileSync(new URL("../dist/phase-rs-zh.bookmarklet.txt", import.meta.url), "utf8");

  assert.ok(url.startsWith("javascript:"), "书签地址必须以 javascript: 开头");
  assert.ok(!url.includes("\n"), "书签地址必须是单行——带换行的书签地址存不进书签栏");

  const body = decodeURIComponent(url.slice("javascript:".length));
  // 控制字符是这条断言的真正价值：压缩器会把源码里的 "\t"/"\n" 字面量改写成真实
  // 控制字符，而一个带控制字符的正文放进书签地址里就容易在不同浏览器上出岔子。
  assert.match(body, /^[\x20-\x7e]*$/, "书签正文必须全是可打印 ASCII（无控制字符、无中文）");
  assert.doesNotThrow(() => new vm.Script(body, { filename: "bookmarklet" }), "书签正文语法不可解析");
});

test("书签小工具：三个产物同源且未过期", () => {
  const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const artifact = readFileSync(
    new URL("../dist/phase-rs-zh.bookmarklet.js", import.meta.url),
    "utf8",
  );
  const url = readFileSync(new URL("../dist/phase-rs-zh.bookmarklet.txt", import.meta.url), "utf8");
  const page = readFileSync(new URL("../dist/install.html", import.meta.url), "utf8");

  const actual = createHash("sha256").update(source).digest("hex").slice(0, 12);

  // 记录在压缩正文尾部的哈希——忘了重新生成就会在这里失败。
  const recorded = /source sha256 \(前 12 位\): ([0-9a-f]{12})/.exec(artifact)?.[1];
  assert.equal(recorded, actual, "书签已过期，请运行 node tools/build-bookmarklet.mjs 重新生成");

  // 安装页里记录的哈希也要对得上。三个产物是一次构建出来的，任何一个落后于源文件
  // 都说明有人只手工改了其中一部分。
  const pageHash = /内容 sha256: <code>([0-9a-f]{12})<\/code>/.exec(page)?.[1];
  assert.equal(pageHash, actual, "安装页记录的哈希与源文件不符");

  // 安装页里那个可拖拽的链接必须与 .txt 完全一致，否则「拖进去的那个」和「手动粘贴
  // 的那个」就是两份不同的代码。
  const href = /href="(javascript:[^"]+)"/.exec(page)?.[1];
  assert.equal(href, url, "安装页的链接与 .txt 不一致");

  // 安装页必须自包含：转发给别人时不该依赖任何外部资源。
  assert.ok(!/<(script|img|link)[^>]+(src|href)="(https?:)?\/\//.test(page), "安装页引用了外部资源");

  // GitHub Pages 的入口必须是同一份页面。GitHub **不渲染**仓库里的 .html（点开只看
  // 到源码），所以「README 里点一下就能拖按钮」全靠 docs/index.html 这一份；它一旦
  // 落后于 dist/install.html，线上与本地就成了两个不同的安装页。
  const pagesEntry = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  assert.equal(pagesEntry, page, "docs/index.html 与 dist/install.html 不一致，请重新运行构建");
});

test("书签小工具：与 src/content.js 行为一致", () => {
  const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const url = readFileSync(new URL("../dist/phase-rs-zh.bookmarklet.txt", import.meta.url), "utf8");
  const body = decodeURIComponent(url.slice("javascript:".length));

  const reference = loadApi(source, "content.js");
  const minified = loadApi(body, "bookmarklet");

  assert.equal(minified.version, reference.version);

  const urls = [
    SCRYFALL, SCRYFALL_SMALL, SCRYFALL_ART, ZHS, SF, SF_ART,
    `https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg`,
    `https://images.mtgch.com/zzs/normal/front/${SHARD_A}/${SHARD_B}/${ID}.webp`,
    "data:image/png;base64,AAAA",
    "",
  ];
  for (const candidate of urls) {
    // 跨 realm 的对象不能用 deepStrictEqual（原型不同），比 JSON 文本。
    assert.equal(
      JSON.stringify(minified.parseArtUrl(candidate)),
      JSON.stringify(reference.parseArtUrl(candidate)),
      `parseArtUrl 不一致：${candidate}`,
    );
    assert.equal(minified.rewriteUrl(candidate), reference.rewriteUrl(candidate), `rewriteUrl 不一致：${candidate}`);
    assert.equal(minified.nextTierUrl(candidate), reference.nextTierUrl(candidate), `nextTierUrl 不一致：${candidate}`);
  }

  const srcset = `${SCRYFALL_SMALL} 146w, ${SCRYFALL} 488w`;
  assert.equal(
    minified.mapSrcset(srcset, minified.rewriteUrl),
    reference.mapSrcset(srcset, reference.rewriteUrl),
    "mapSrcset 结果不一致",
  );
});
