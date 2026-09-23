/**
 * 装配测试：把书签脚本本体（`src/content.js`）真的跑起来，验证它在 DOM 里确实
 * 拦得住、改得对、失败时降得下去。
 *
 * 为什么这层测试必须存在：脚本的核心假设不是 URL 拼接（那部分在 `test/content.test.mjs`
 * 里用零依赖的 Node 单测覆盖），而是
 *   1. 给 `Element.prototype.setAttribute` 打补丁能拦住 React 的写入；
 *   2. 在捕获阶段 `stopPropagation()` 能压住应用的 `onError`。
 * 这两条一旦不成立，脚本要么不生效，要么把卡牌打成文字占位，而纯函数测试完全看不出来。
 *
 * 直接加载真实文件而不是复制一份实现——复制出来的那份会随时间与本体脱节。
 *
 * 三个写法上的硬约束：
 *   1. 元素必须挂到 document 上。`error` 不冒泡，事件要靠捕获阶段从 window 下来；
 *      游离节点没有传播路径，window 上的监听根本不会触发（真实浏览器里游离的 img
 *      也压根不会发起加载）。
 *   2. 每张走完「降级到 Scryfall」的图都要用独立印刷 id。`givenUp` 是模块级状态，
 *      共用 id 会让后面的断言莫名失败。
 *   3. 用 `vm.runInThisContext` 而不是 import：脚本是 classic script，且每次注入都要
 *      走一遍它自己的装配逻辑（「重复装配幂等」这条用例正是靠这一点）。
 *
 * 运行需要 vitest + happy-dom（见 package.json）：`npm install && npm run test:dom`。
 * 零依赖的那套用 `npm test`。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

// 不用 `new URL(..., import.meta.url)`：vitest 的 happy-dom 环境在某些运行方式下
// 会让 import.meta.url 不是 file: 协议，readFileSync 会直接抛「URL must be of
// scheme file」。import.meta.dirname 稳定给出真实目录（已实测）。
const SCRIPT_SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "content.js"), "utf8");

/** 真实印刷：2X2 #117 Lightning Bolt（大学院废墟有简体中文图）。 */
const ID = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
const SCRYFALL = `https://cards.scryfall.io/normal/front/f/2/${ID}.jpg?1783921885`;
const ZHS = `https://images.mtgch.com/zhs/normal/front/f/2/${ID}.webp`;
const SF = `https://images.mtgch.com/sf/normal/front/f/2/${ID}.webp`;
const SCRYFALL_ART = `https://cards.scryfall.io/art_crop/front/f/2/${ID}.jpg?1783921885`;
const SF_ART = `https://images.mtgch.com/sf/art_crop/front/f/2/${ID}.webp`;

/** 另两张印刷，给会走完降级阶梯的用例独占。 */
const LADDER_ID = "11bf83bb-c95b-4b4f-9a56-ce7a1816307a";
const LADDER_SF = `https://images.mtgch.com/sf/normal/front/1/1/${LADDER_ID}.webp`;
const LADDER_SCRYFALL = `https://cards.scryfall.io/normal/front/1/1/${LADDER_ID}.jpg`;

const LOOP_ID = "000d9280-a79a-4f9f-822c-7aaecbff3337";
const LOOP_SCRYFALL = `https://cards.scryfall.io/normal/front/0/0/${LOOP_ID}.jpg`;
const LOOP_SF = `https://images.mtgch.com/sf/normal/front/0/0/${LOOP_ID}.webp`;

/** 只给「重复装配」用例独占，避免与其它用例的放弃集合互相影响。 */
const TWICE_ID = "a471b306-4941-4e46-a0cb-d92895c16f8a";
const TWICE_ZHS = `https://images.mtgch.com/zhs/normal/front/a/4/${TWICE_ID}.webp`;
const TWICE_SF = `https://images.mtgch.com/sf/normal/front/a/4/${TWICE_ID}.webp`;

beforeAll(() => {
  vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js" });
});

/** 建一个已挂到文档上的 img——游离节点的事件到不了 window。 */
function attachedImage(src) {
  const element = document.createElement("img");
  if (src !== undefined) element.setAttribute("src", src);
  document.body.append(element);
  return element;
}

describe("装配：属性写入时改写", () => {
  it("setAttribute 写 src 被同步改写成中文图", () => {
    const element = attachedImage();
    element.setAttribute("src", SCRYFALL);
    expect(element.getAttribute("src")).toBe(ZHS);
  });

  it("React 用的 src 属性赋值同样被改写", () => {
    const element = attachedImage();
    element.src = SCRYFALL;
    expect(element.getAttribute("src")).toBe(ZHS);
  });

  it("srcset 的每个候选与描述符都被改写", () => {
    const element = attachedImage();
    const small = `https://cards.scryfall.io/small/front/f/2/${ID}.jpg?1783921885`;
    element.setAttribute("srcset", `${small} 146w, ${SCRYFALL} 488w`);
    expect(element.getAttribute("srcset")).toBe(
      `https://images.mtgch.com/zhs/small/front/f/2/${ID}.webp 146w, ${ZHS} 488w`,
    );
  });

  it("art_crop 走大学院废墟英文层（无中文裁切图）", () => {
    const element = attachedImage(SCRYFALL_ART);
    expect(element.getAttribute("src")).toBe(SF_ART);
  });

  it("牌背与其他域名的图片原样放过", () => {
    const back = "https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";
    const element = attachedImage(back);
    expect(element.getAttribute("src")).toBe(back);
  });
});

describe("装配：加载失败的降级阶梯", () => {
  it("中文图失败 → 降到大学院废墟英文图，且不给应用 onError 机会", () => {
    const element = attachedImage(ZHS);
    let appNotified = false;
    element.addEventListener("error", () => {
      appNotified = true;
    });

    element.dispatchEvent(new Event("error"));

    expect(element.getAttribute("src")).toBe(SF);
    // 关键：应用自己的 onError 一旦跑到，就会把整张卡换成文字占位。
    expect(appNotified).toBe(false);
  });

  it("srcset 与 src 一起降级，保持两级一致", () => {
    const element = attachedImage();
    element.setAttribute(
      "srcset",
      `https://images.mtgch.com/zhs/small/front/f/2/${ID}.webp 146w, ${ZHS} 488w`,
    );
    element.setAttribute("src", ZHS);

    element.dispatchEvent(new Event("error"));

    expect(element.getAttribute("src")).toBe(SF);
    expect(element.getAttribute("srcset")).toBe(
      `https://images.mtgch.com/sf/small/front/f/2/${ID}.webp 146w, ${SF} 488w`,
    );
  });

  it("英文图再失败 → 退到 Scryfall 兜底，仍不给应用 onError 机会", () => {
    const element = attachedImage(LADDER_SF);
    let appNotified = false;
    element.addEventListener("error", () => {
      appNotified = true;
    });

    element.dispatchEvent(new Event("error"));

    expect(element.getAttribute("src")).toBe(LADDER_SCRYFALL);
    expect(appNotified).toBe(false);
  });

  it("Scryfall 兜底层再失败 → 放手交回应用，且不会被打回中文层", () => {
    const element = attachedImage(LOOP_SF);
    element.dispatchEvent(new Event("error"));
    expect(element.getAttribute("src")).toBe(LOOP_SCRYFALL);

    let appNotified = false;
    element.addEventListener("error", () => {
      appNotified = true;
    });
    element.dispatchEvent(new Event("error"));

    // 交回应用：它自己的降级链会接手（例如换成文字占位）。
    expect(appNotified).toBe(true);
    // 并且不能被打回中文层——那会变成 404 → 改写 → 404 的死循环。
    expect(element.getAttribute("src")).toBe(LOOP_SCRYFALL);
  });

  it("非图片元素上的 error 不受影响", () => {
    const element = document.createElement("div");
    document.body.append(element);
    let observed = false;
    element.addEventListener("error", () => {
      observed = true;
    });

    expect(() => element.dispatchEvent(new Event("error"))).not.toThrow();
    expect(observed).toBe(true);
  });

  it("重复装配被幂等闸挡下：一次加载失败只降一级", () => {
    // 重复点击书签是常态。若装配不幂等，第二次会再挂一个 window 上的 error 监听
    // ——一次 404 被两个监听各降一级，中文图会直接跳过英文层掉到 Scryfall 兜底。
    // 这里把脚本再注入一次，验证阶梯仍然只走一步。
    vm.runInThisContext(SCRIPT_SOURCE, { filename: "phase-rs-zh/src/content.js (第二次)" });

    const element = attachedImage(TWICE_ZHS);
    element.dispatchEvent(new Event("error"));

    expect(element.getAttribute("src")).toBe(TWICE_SF);
  });
});
