/**
 * Phase 中文卡图 — content script（MAIN world，document_start）。
 *
 * 作用：把 phase.rs 网页版渲染的卡图，全部改走大学院废墟（sbwsz.com）的图床：
 * 该印刷有简体中文图就用中文图，没有就用大学院废墟自己的英文图。开启插件即生效；
 * 关闭插件后本脚本不被注入，页面自然回到 Scryfall 英文图。
 *
 * ── 三级阶梯 ────────────────────────────────────────────────────────────
 *
 * 两张 CDN 的 URL 形状一一对应，改动只是 host、`/zhs|sf/` 前缀和扩展名：
 *
 *   https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg?1783921885
 *   https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp   ← 中文
 *   https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp    ← 英文
 *
 * 改写是无状态的、同步的，不需要查任何 API：大学院废墟对「没有中文图」的印刷
 * 直接让 `/zhs/` 路径返回 404，这个 404 就是判据。加载失败时本脚本把该元素降到
 * 下一级，于是：
 *
 *   zhs（中文） --404--> sf（英文，仍是大学院废墟） --404--> scryfall（最终兜底）
 *
 * 第三级看似冗余——它就位是为了保证「绝不会比原版更差」。前两级都取不到图时
 * 说明大学院废墟侧缺这张印刷，此时退回应用本来就用的 Scryfall URL，而不是让
 * 卡牌变成裂图。
 *
 * `art_crop`（插画裁切）直接走 `sf`：画框裁切只是插画本身，与语言文字无关，
 * 大学院废墟也没有 `zhs/art_crop`（实测 404）。其 `/sf/art_crop/…` 实测为
 * 626x457，与 Scryfall 的 art_crop 尺寸一致，所以换过去不改变取景。
 *
 * ── 为什么必须「先改写，失败再降级」而不是交给 onError 处理 ──────────────
 *
 * phase.rs 的 CardImage 自带降级链：`onError={() => advanceFailedSource(src)}`。
 * 一旦换上去的图加载失败，应用的降级链会认为这张卡的美术挂了，把整张卡换成纯
 * 文字占位——比看到英文卡图糟得多。所以本脚本在捕获阶段拦下 `error`，自己降级，
 * 并用 `stopPropagation()` 阻止应用自己的 onError 触发。只有当 URL 已经处于
 * 最后一级（Scryfall）时我们才放手，让应用按原有逻辑降级——那才是真正的加载
 * 失败。
 *
 * ── 为什么在 MAIN world ─────────────────────────────────────────────────
 *
 * 要零闪烁就必须在浏览器发起请求之前改掉属性值。React 18 通过
 * `node.setAttribute(...)` 写入 `src` 与 `srcset`，而隔离世界的 content script
 * 改不了页面原型。MAIN world（Chromium 111+）里可以直接给
 * `Element.prototype.setAttribute` 打补丁，同步改写，浏览器永远看不到英文 URL。
 * 代价是拿不到 `chrome.*` API——本脚本也不需要，它不请求任何接口。
 *
 * ── 刻意不处理的东西 ───────────────────────────────────────────────────
 *
 * - `backs.scryfall.io`（CARD_BACK_URL，牌背）与语言无关，host 不匹配即跳过。
 * - 已安装的「图像包」：用户显式安装的资源，URL 不在 scryfall.io 下，天然不碰。
 * - small/normal/large/art_crop 之外的尺寸（png、border_crop、thumb…）：应用
 *   目前不使用，遇到就原样放过，不猜。
 * - 桌面版（DMG / Tauri 套壳）：浏览器扩展不作用于 WebView，本插件只覆盖网页版。
 *
 * ── 隐私与缓存 ─────────────────────────────────────────────────────────
 *
 * 不写任何持久化状态：没有 localStorage / sessionStorage / cookie，不查 API，
 * 不缓存图片。它做的全部事情就是在属性写入时换一个 URL，在加载失败时降级。
 */
(() => {
  "use strict";

  /**
   * 必须与 manifest.json 的 `version` 一致——它是用户在控制台确认「装的是哪一版」
   * 的唯一依据，而控制台那行日志是排障的第一步。test/content.test.mjs 里有断言
   * 防止两者漂移。
   */
  const VERSION = "1.0.0";

  const SCRYFALL_IMAGE_HOST = "cards.scryfall.io";
  const MTGCH_IMAGE_HOST = "images.mtgch.com";

  const ZHS_PREFIX = "zhs";
  const SF_PREFIX = "sf";

  /**
   * 三个来源层级。`prefix` 为 null 表示该 host 下没有子目录（Scryfall）。
   * `artCrop` 表示该层是否提供插画裁切图：中文层不提供（插画与语言无关）。
   */
  const TIERS = {
    zh: { host: MTGCH_IMAGE_HOST, prefix: ZHS_PREFIX, extension: "webp", artCrop: false },
    "mtg-en": { host: MTGCH_IMAGE_HOST, prefix: SF_PREFIX, extension: "webp", artCrop: true },
    scryfall: { host: SCRYFALL_IMAGE_HOST, prefix: null, extension: "jpg", artCrop: true },
  };

  const TIER_ORDER = ["zh", "mtg-en", "scryfall"];

  /** 带卡面的尺寸。应用只用这三种，加 art_crop 共四种。 */
  const FACE_SIZES = new Set(["small", "normal", "large"]);
  const ART_CROP = "art_crop";
  const FACES = new Set(["front", "back"]);

  const ART_FILENAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/;

  // ────────────────────────────────────────────────────────────────────────
  // URL 解析与改写（纯函数，可脱离 DOM 单测）
  // ────────────────────────────────────────────────────────────────────────

  /**
   * 拆出 scheme / host / path 段。
   *
   * 不用 `new URL()` 的原因和 phase.rs 里 `splitSizedImageUrl` 一致：这里会在
   * 每个卡图属性上被调用，输入可能是空串、相对路径或测试替身；手写拆分没有
   * 抛异常的分支，不认识就返回 null。
   */
  function splitHttpsUrl(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/.exec(value);
    if (!match) return null;
    const [, scheme, host, pathname] = match;
    return {
      scheme,
      host: host.toLowerCase(),
      segments: pathname.split("/").filter((segment) => segment.length > 0),
    };
  }

  /**
   * 把一张卡图 URL 解析成 `{ tier, ref }`，或返回 null。
   *
   * `ref` 里的分片目录（uuid 的前两位）会与 uuid 交叉校验，这样一条构造畸形的
   * URL 不会被改写成另一张卡的图片请求——宁可漏改，不可改错。
   */
  function parseArtUrl(value) {
    const split = splitHttpsUrl(value);
    if (!split || split.scheme !== "https") return null;

    let tier = null;
    let segments = split.segments;
    if (split.host === SCRYFALL_IMAGE_HOST) {
      tier = "scryfall";
    } else if (split.host === MTGCH_IMAGE_HOST) {
      if (segments[0] === ZHS_PREFIX) tier = "zh";
      else if (segments[0] === SF_PREFIX) tier = "mtg-en";
      else return null;
      segments = segments.slice(1);
    } else {
      return null;
    }
    if (segments.length !== 5) return null;

    const [size, face, shardA, shardB, filename] = segments;
    if (!FACE_SIZES.has(size) && size !== ART_CROP) return null;
    if (size === ART_CROP && !TIERS[tier].artCrop) return null;
    if (!FACES.has(face)) return null;
    if (!/^[0-9a-f]$/.test(shardA) || !/^[0-9a-f]$/.test(shardB)) return null;

    const match = ART_FILENAME.exec(filename);
    if (!match) return null;
    const printingId = match[1];
    if (printingId[0] !== shardA || printingId[1] !== shardB) return null;

    return { tier, ref: { size, face, shardA, shardB, printingId } };
  }

  /** 按层级把 `ref` 渲染成 URL。这是全脚本唯一的 URL 拼装点。 */
  function urlFor(tier, ref) {
    const spec = TIERS[tier];
    const prefix = spec.prefix ? `/${spec.prefix}` : "";
    return `https://${spec.host}${prefix}`
      + `/${ref.size}/${ref.face}/${ref.shardA}/${ref.shardB}/${ref.printingId}.${spec.extension}`;
  }

  /**
   * 已经确认大学院废墟两层都取不到图的 `印刷id:尺寸`。
   *
   * 为什么必须有这个集合：降到第三级时要写回 Scryfall URL，而这次写入会再次
   * 经过我们补丁过的 `setAttribute`，于是 `rewriteUrl` 会立刻把它改回中文层，
   * 造成 404 → 改写 → 404 的死循环。登记之后 `rewriteUrl` 对这张图原样放过。
   *
   * 按「印刷 + 尺寸」而不是只按印刷做键：`sf/art_crop` 缺失不代表同一张印刷的
   * `zhs/normal` 也缺失，键太粗会让整张卡白丢中文。
   *
   * 纯内存、不持久化；页面刷新即重置。有上限，避免长会话里无界增长。
   */
  const givenUp = new Set();
  const MAX_GIVEN_UP = 5000;

  function ladderKey(ref) {
    return `${ref.printingId}:${ref.size}`;
  }

  function giveUpOn(ref) {
    if (givenUp.size >= MAX_GIVEN_UP) givenUp.clear();
    givenUp.add(ladderKey(ref));
  }

  /**
   * 应用的英文卡图 URL → 我们想显示的第一选择。
   *
   * 带卡面的尺寸走中文层；`art_crop` 走英文层（中文层没有这个尺寸，插画也与
   * 语言无关）。已经是大学院废墟的 URL、以及任何不认识的输入都原样返回，所以
   * 本函数是幂等的——属性写入路径会重复经过它。已放弃的图直接返回原值。
   */
  function rewriteUrl(value) {
    const parsed = parseArtUrl(value);
    if (!parsed || parsed.tier !== "scryfall") return value;
    if (givenUp.has(ladderKey(parsed.ref))) return value;
    return urlFor(parsed.ref.size === ART_CROP ? "mtg-en" : "zh", parsed.ref);
  }

  /**
   * 加载失败时的下一级 URL，或 null（已在最后一级，交给应用自己降级）。
   *
   * 准备退到 Scryfall 层时顺手登记放弃——登记必须发生在写回属性之前，见
   * `givenUp` 的说明。
   */
  function nextTierUrl(value) {
    const parsed = parseArtUrl(value);
    if (!parsed) return null;
    const next = TIER_ORDER[TIER_ORDER.indexOf(parsed.tier) + 1];
    if (!next) return null;
    if (next === "scryfall") giveUpOn(parsed.ref);
    return urlFor(next, parsed.ref);
  }

  /**
   * `srcset` 语法里的空白字符（HTML 规范的定义）：空格、TAB、LF、FF、CR。
   *
   * 用码点表而不是 `"\t"` / `"\n"` 这类转义字面量：压缩器会把它们改写成**真实的**
   * 控制字符（esbuild 就会），而书签小工具的正文要能安全地放进一个 URL 里，一个
   * 控制字符都不该有。写成码点表顺带把「哪些字符算空白」变成了可读的数据。
   */
  const SRCSET_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0c, 0x0d]);

  function isSrcsetWhitespace(character) {
    return SRCSET_WHITESPACE.has(character.charCodeAt(0));
  }

  /**
   * 对 `srcset` 的每个候选套用 `map`，保留 `146w` / `2x` 这类描述符。
   * 一个都没变时返回原串，避免无谓的属性写入（那会再触发 MutationObserver）。
   *
   * 不能简单地按逗号切分：`data:` URL 自带逗号（`data:image/png;base64,AAAA`），
   * 按逗号切会把一个候选拆成两个。这里按 srcset 的解析规则走——URL 到空白或
   * 分隔逗号为止，而 `data:` URL 里的逗号属于 URL 本身；描述符则是接下来的
   * 非空白内容，直到下一个逗号。
   */
  function mapSrcset(value, map) {
    if (typeof value !== "string" || value.length === 0) return value;

    let index = 0;
    let changed = false;
    const candidates = [];

    while (index < value.length) {
      // 跳过候选之间的空白与分隔逗号。
      while (index < value.length && (isSrcsetWhitespace(value[index]) || value[index] === ",")) index += 1;
      if (index >= value.length) break;

      const isDataUrl = value.slice(index, index + 5).toLowerCase() === "data:";
      const urlStart = index;
      while (index < value.length && !isSrcsetWhitespace(value[index])) {
        if (!isDataUrl && value[index] === ",") break;
        index += 1;
      }
      // 仅 `data:` 分支可能收集到结尾的分隔逗号。
      const url = value.slice(urlStart, index).replace(/,+$/, "");

      // URL 与描述符之间的空白要原样保留，否则 `… 1x, … 2x` 会被拼成 `…1x`。
      const separatorStart = index;
      while (index < value.length && isSrcsetWhitespace(value[index])) index += 1;
      const separator = value.slice(separatorStart, index);
      const descriptorStart = index;
      while (index < value.length && value[index] !== ",") index += 1;
      const descriptor = value.slice(descriptorStart, index);

      if (url.length === 0) continue;
      const next = map(url);
      if (next !== url) changed = true;
      candidates.push(`${next}${separator}${descriptor}`);
    }

    return changed ? candidates.join(", ") : value;
  }

  // ────────────────────────────────────────────────────────────────────────
  // DOM 改写
  // ────────────────────────────────────────────────────────────────────────

  function rewriteElement(image) {
    const src = image.getAttribute("src");
    if (src) {
      const next = rewriteUrl(src);
      if (next !== src) image.setAttribute("src", next);
    }
    const srcset = image.getAttribute("srcset");
    if (srcset) {
      const next = mapSrcset(srcset, rewriteUrl);
      if (next !== srcset) image.setAttribute("srcset", next);
    }
  }

  function scan() {
    // 用 querySelectorAll 而不是 document.images：语义相同（都是文档里的 img
    // 元素），但 document.images 并非所有 DOM 实现都提供，测试环境就会缺。
    for (const image of Array.from(document.querySelectorAll("img"))) rewriteElement(image);
  }

  /**
   * 把该元素上仍处于大学院废墟层级的 URL 整体降一级。
   *
   * 返回是否真的降级了：没有可降的（已是 Scryfall 层，或根本不是卡图）返回
   * false，调用方据此决定要不要拦下错误事件。
   *
   * `srcset` 先写、`src` 后写：带 `sizes` 的 srcset 优先于 src，先落 srcset 才能
   * 保证这次重载取的是新的一级。
   */
  function advanceLadder(image) {
    const src = image.getAttribute("src");
    const srcset = image.getAttribute("srcset");

    const nextSrcset = srcset ? mapSrcset(srcset, (url) => nextTierUrl(url) ?? url) : null;
    const nextSrc = src ? nextTierUrl(src) : null;

    const srcsetChanged = nextSrcset !== null && nextSrcset !== srcset;
    const srcChanged = nextSrc !== null && nextSrc !== src;

    if (srcsetChanged) image.setAttribute("srcset", nextSrcset);
    if (srcChanged) image.setAttribute("src", nextSrc);
    return srcsetChanged || srcChanged;
  }

  /**
   * 图片来源加载失败。
   *
   * 只处理还处在大学院废墟层级的元素：降一级并阻止事件继续传播，否则
   * phase.rs 自己的 `onError` 会把整张卡降级成文字占位——而失败的只是我们
   * 替换的那张图。已经退到 Scryfall 层还失败，说明是真的加载不出来，此时放手
   * 让应用按原有逻辑处理。
   */
  function onResourceError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (advanceLadder(image)) event.stopPropagation();
  }

  // ────────────────────────────────────────────────────────────────────────
  // 装配
  // ────────────────────────────────────────────────────────────────────────

  /** 给 `HTMLImageElement.prototype` 上的一个反射属性打补丁。 */
  function patchImageProperty(name, map) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name);
    if (!descriptor || typeof descriptor.set !== "function" || typeof descriptor.get !== "function") return;
    Object.defineProperty(HTMLImageElement.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        descriptor.set.call(this, map(value));
      },
    });
  }

  /**
   * 给 `Element.prototype.setAttribute` 打补丁。
   *
   * 这是真正起作用的那一层：React 18 对 `src` / `srcset` 走的是
   * `node.setAttribute(...)`，在这里同步改写，浏览器就不会先发一次英文请求，
   * 也就没有「先闪一下英文」。
   */
  function patchSetAttribute() {
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (this instanceof HTMLImageElement) {
        const attribute = String(name).toLowerCase();
        if (attribute === "src") {
          value = rewriteUrl(String(value));
        } else if (attribute === "srcset") {
          value = mapSrcset(String(value), rewriteUrl);
        }
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }

  /** 兜底：内联 HTML、SSR 或任何绕开上面两条路径的属性写入。 */
  function observe() {
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== "attributes") continue;
        const target = record.target;
        if (target instanceof HTMLImageElement) rewriteElement(target);
      }
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"],
    });
  }

  /**
   * 装配。必须在同一文档里幂等。
   *
   * 书签小工具载体下重复点击是常态（切换页面、手滑、忘了点过）。不加这道闸，
   * 第二次点击会再挂一个 window 上的 error 监听：一次加载失败会让两个监听各降
   * 一级，中文图直接跳过英文层掉到 Scryfall 兜底——正好破坏了阶梯存在的意义。
   * 扩展载体下浏览器只注入一次，但这条闸对两个载体都成立，没有理由不加。
   *
   * 重复进入时仍跑一次 `scan()`：把上次点击之后新渲染出来的图补上。
   */
  function install() {
    if (globalThis.__phaseZhCardArtInstalled === true) {
      scan();
      return;
    }
    globalThis.__phaseZhCardArtInstalled = true;

    patchImageProperty("src", rewriteUrl);
    patchImageProperty("srcSet", (value) => mapSrcset(value, rewriteUrl));
    patchImageProperty("srcset", (value) => mapSrcset(value, rewriteUrl));
    patchSetAttribute();
    observe();
    window.addEventListener("error", onResourceError, true);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scan, { once: true });
    } else {
      scan();
    }
    console.info(`[phase-rs-zh] 已启用 v${VERSION}`);
  }

  // 测试与诊断入口。测试在 DOM 环境里加载本文件后从这里取纯函数断言。
  globalThis.__phaseZhCardArt = {
    version: VERSION,
    tiers: TIERS,
    splitHttpsUrl,
    parseArtUrl,
    urlFor,
    rewriteUrl,
    nextTierUrl,
    mapSrcset,
    advanceLadder,
    rewriteElement,
    givenUp,
  };

  // 脱离 DOM 加载（Node 单测）时只暴露上面的纯函数，不装配。
  if (typeof window !== "undefined" && typeof document !== "undefined"
    && typeof HTMLImageElement === "function") {
    install();
  }
})();
