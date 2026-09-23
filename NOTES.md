# phase-rs-zh 技术笔记

这份文档面向「要改这个工具」或「想知道它为什么这么做」的人。
**安装与日常使用看 [README.md](README.md) 就够了。**

---

## 它需要 phase.rs 的仓库吗？

**不需要。** 运行时完全独立：书签就是一段在页面里执行的 JS，它不认识 phase.rs 的代码、
不 import 任何东西、不请求任何接口。它能工作的全部依据是「应用渲染出了
`cards.scryfall.io` 的卡图 URL」这一件事。

唯一的例外是一个**可选的**守卫脚本：`tools/check-app-data-coverage.mjs` 读
`client/public/scryfall-*.json`，那是 phase.rs 仓库里的生成物。没有仓库它跑不了，
但**工具本身照常工作**。

所以：phase.rs 的仓库可以不要。本仓库是独立仓库
（<https://github.com/haowen1993/phase-rs-zh>），克隆它就能开始开发，不需要
phase.rs 的任何东西。想跑那个可选的覆盖率守卫时，才需要另外克隆一份 phase.rs。

## 效果与实测覆盖率

| 情况 | 显示 |
| --- | --- |
| 大学院废墟有该印刷的简体中文图 | 中文卡图（`images.mtgch.com/zhs/…`） |
| 大学院废墟没有中文图 | 大学院废墟的英文图（`images.mtgch.com/sf/…`） |
| 大学院废墟连英文图都没有 | 回退到应用原本的 Scryfall URL（兜底） |

覆盖正面、背面（双面牌）、`small` / `normal` / `large` 三种尺寸，以及衍生物（token）。

实测（用 phase.rs 自己的 90,607 张印刷数据取样，`Range: 0-0` 每张只探 1 字节）：

| 样本 | 大学院废墟英文图 | 简体中文图 |
| --- | --- | --- |
| 最新 60 张（含 2027 促销、2026 Star Trek） | 60/60 = 100% | 0/60（这些本来就没有中文印刷） |
| 随机 60 张（1993–2027） | 60/60 = 100% | 25/60 = 42% |

所以第三级（退回 Scryfall）在实际样本里一次都没触发；它守的是「新系列刚发售、
Scryfall 已有图而大学院废墟还没同步完」那段窗口。

## 原理：三级阶梯

两张 CDN 的 URL 形状一一对应，差别只有 host、`/zhs|sf/` 前缀和扩展名：

```
https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg?1783921885   ← 应用原本输出
        │  在属性写入时同步改写（small | normal | large，正/背面）
        ▼
https://images.mtgch.com/zhs/normal/front/f/2/<uuid>.webp          ← 中文卡图
        │  404（该印刷没有中文图）
        ▼
https://images.mtgch.com/sf/normal/front/f/2/<uuid>.webp           ← 大学院废墟的英文图
        │  404（兜底，几乎不会发生）
        ▼
https://cards.scryfall.io/normal/front/f/2/<uuid>.jpg              ← 绝不让画面比原版更差
```

**判据就是 404，不需要查 API。** 大学院废墟对没有中文图的印刷直接让 `/zhs/` 路径返回
404，脚本在图片加载失败时把该元素降到下一级。全程自动，你不参与任何判断。

`art_crop`（插画裁切）直接走 `sf` 层：画框裁切只是插画本身，与语言文字无关，大学院
废墟也没有 `zhs/art_crop`（实测 404）。其 `sf/art_crop/…` 实测为 626×457，与 Scryfall
的 art_crop 尺寸一致，换过去不改变取景。

### 为什么书签能做到这件事

脚本要在浏览器发起请求**之前**改掉属性值，否则会先闪一下英文图。React 通过
`node.setAttribute("src" / "srcset", …)` 写属性，而只有**页面自己的 JS 世界**才改得动
页面原型——浏览器扩展的隔离世界改不了（所以扩展必须声明 `world: "MAIN"`），
userscript 管理器的默认沙箱也改不了（所以必须写 `@inject-into page`）。

书签的 `javascript:` 地址**本来就在页面自己的世界里执行**，这个坑天然不存在。

代价是注入时机由你点击决定，而不是页面加载时。脚本对此不敏感：它既给后续的属性写入
打补丁，也会在注入瞬间扫一遍页面上已存在的卡图，所以点之前已经渲染出来的卡同样会变中文。

### 两个必须小心的地方

**一、失败时不能交给应用自己的降级链。** phase.rs 的 `CardImage` 带
`onError={() => advanceFailedSource(src)}`。一旦换上去的图加载失败，应用的降级链会以为
这张卡的美术挂了，把整张卡换成**纯文字占位**——比看到英文卡图糟得多。所以脚本在捕获
阶段拦下 `error`、自己降级，并用 `stopPropagation()` 阻止应用的 `onError` 触发。只有
退到最后的 Scryfall 层还失败时，才放手让应用按原有逻辑降级。

**二、退到 Scryfall 层会死循环。** 写回 Scryfall URL 会再次经过我们补丁过的
`setAttribute`，于是被立刻打回中文层，形成 `404 → 改写 → 404`。所以退级前先把该
`印刷id:尺寸` 记入一个内存里的「放弃」集合，`rewriteUrl` 对已放弃的图原样放过。
按尺寸而不是只按印刷做键：`sf/art_crop` 缺失不代表同一张印刷的 `zhs/normal` 也缺失。

另外，重复点击书签不能让同一张图降两级（两个 error 监听各降一级就会跳过英文层），
所以装配带一道幂等闸；重复点击只会重新扫一遍页面。

## phase.rs 更新了怎么办

**通常什么都不用做。** 这个工具依赖的是四个「外部契约」，都不是 phase.rs 的内部实现：

1. 卡图 URL 的形状——那是 **Scryfall** 的格式，不是 phase.rs 的代码；
2. 应用用 `<img>` + 属性写入渲染卡图——React 的通用行为；
3. 应用带 `onError` 降级链——我们压住它，即使它被删掉我们也不受影响；
4. 大学院废墟的路径约定——第三方。

真要动手的情况只有这几种：

| 变化 | 症状 | 需要改什么 |
| --- | --- | --- |
| phase.rs 换掉卡图 CDN（不再用 Scryfall） | 点书签后**完全没反应** | 改 `src/content.js` 里两个 host 常量与路径判断（几行），重新构建 |
| 大学院废墟改了路径 | **静默**退回英文图或 Scryfall | `node tools/check-live.mjs` 会直接告诉你 |
| phase.rs 加了严格 CSP | 书签完全失效（控制台报 CSP 违规） | 书签路线走不通，需要改成浏览器扩展。本仓库不含扩展代码，得重写（`src/content.js` 的逻辑可以直接复用，要改的只是「怎么送进页面主世界」那一层） |
| 新增卡图尺寸（如 `grid`、`thumb`） | 只有那批图保持英文 | 往 `FACE_SIZES` 加尺寸；不加也不影响其他卡 |
| 应用改成完全不写 `src` 属性 | 完全没反应 | 现在还有 `MutationObserver` 兜底；连属性都不写就得换方案 |

**更新后花两分钟自查：**

```bash
node tools/check-live.mjs    # 第三方那一侧（需要网络，在本仓库里跑）

# 应用那一侧：该脚本读 client/public/scryfall-*.json，所以要在 phase.rs 克隆的
# 根目录下运行，指向本仓库里的脚本（本仓库不需要是 phase.rs 的子目录）
cd /path/to/phase-rs-clone
node /path/to/phase-rs-zh/tools/check-app-data-coverage.mjs
```

再用浏览器打开应用点一次书签，随便看一张卡。三条都过就什么都不用做。

## 本地需要留什么

**必留**（这就是后续开发所需的全部）：

```
src/content.js                  逻辑——你唯一要改的文件
tools/build-bookmarklet.mjs     重新生成三个产物
test/content.test.mjs           零依赖测试（node --test）
dist/                           产物；可再生，但留着省事
README.md                       这份文档
```

**可选**：

```
tools/check-live.mjs              守大学院废墟那侧的 URL 约定（需要网络）
test/assembly.dom.mjs              DOM 装配测试（需要 node_modules）
vitest.config.mjs  package.json    上面那个测试的配置
tools/check-app-data-coverage.mjs  守应用那侧；只有留着 phase.rs 仓库才有用
node_modules/                     esbuild + vitest + happy-dom，删了 npm install 就能回来
```

重新构建需要一个 **esbuild**，而它已经是本仓库的 devDependency——`npm install` 之后
`npm run build` 就能用。构建脚本的查找顺序是：

1. `ESBUILD_BIN` 环境变量（想指定某个特定版本时用）；
2. **本目录自带的 `node_modules/.bin/esbuild`**（主路径；显式找它，所以直接
   `node tools/build-bookmarklet.mjs` 也能跑，不必经过 npm）；
3. `PATH` 上的任意 esbuild（`brew install esbuild` 也行）；
4. 万一本目录被放进某个 phase.rs 克隆里，用它 `client/` 下已装好的那份。

也就是说本仓库自带构建依赖，不依赖任何外部环境。

## 维护

```bash
npm run build      # 从 src/content.js 重新生成 dist/ 三件套
npm test           # 零依赖：纯逻辑 + 产物同源/等价校验（17 项）
npm run check:live # 对真实图床核对三级阶梯（需要网络）
npm run test:dom   # DOM 装配测试（11 项，需先 npm install）
```

`node_modules/` 只是 `test:dom` 需要的 56 MB，随时可以删掉重新装。如果 `npm install`
报 `EPERM` 或「cache folder contains root-owned files」（本机就遇到过），那是在用系统
级 npm 缓存导致的，两种解法：

```bash
npm install --cache /tmp/npm-cache     # 换一个私有缓存目录，立即绕开
sudo chown -R $(id -u):$(id -g) ~/.npm # 或者根治那个缓存目录的属主
```

`npm test` 里有三道防漂移，保证「逻辑只有一份」不是靠自觉：

1. 书签地址必须是**单行、纯 ASCII、无控制字符**。压缩器会把源码里的 `"\t"` / `"\n"`
   改写成真实控制字符，所以 `src/content.js` 里刻意用码点表做空白比较。
2. 压缩正文尾部记录的 `src/content.js` sha256 必须对得上；安装页里记录的哈希、以及
   安装页里可拖拽的链接与 `.txt` 的一致性，也一并校验。
3. 压缩后的正文与源码在干净沙箱里跑同一组断言，逐项比对结果。

改了源文件却忘了重新生成，第 2 条会直接失败。

`npm run test:dom` 覆盖的是纯函数测试看不出来的部分：给 `Element.prototype.setAttribute`
打补丁能否拦住 React 的写入、捕获阶段 `stopPropagation()` 能否压住应用的 `onError`、
降级阶梯是否只走一级、重复装配是否幂等。

### 手动验收

1. 打开 <https://phase-rs.dev>，进入一局游戏或打开牌组。
2. 点一下书签栏里的「中文卡图」。
3. 卡图应为简体中文。Web Inspector → 网络 过滤 `images.mtgch.com`，应看到 `/zhs/…` 200。
4. 找一张确实没有中文图的印刷（例如 Unfinity 的 *Standard Procedure*）：应显示英文
   卡图，**而不是**文字占位卡——网络面板里先出现 `/zhs/…` 404，紧接着 `/sf/…` 200。
5. 刷新页面且不再点书签，卡图应恢复为原版 Scryfall 英文图。
6. 连点两次书签：不应有任何异常（幂等）。

## 已知限制

- **每次重新加载页面后要点一下。** 页面内跳转不需要。
- **只作用于网页版。** 桌面版（DMG / Tauri 套壳）是个把 WebView 导航到
  `https://phase-rs.dev` 的壳，书签在 WebView 里用不了。
- **不翻译界面文案。** 只改卡图。
- **没有中文图的卡会闪一下。** 中文层 404 之后才降到英文层，间隔通常小于 100ms，
  且同一张图在一次会话里只发生一次。
- **中文图由第三方社区站点提供。** 覆盖范围与画质取决于大学院废墟；刚发售的新系列
  可能还没镜像，此时靠英文层或 Scryfall 兜底，不会出现裂图。
- **只处理应用实际使用的四种尺寸**（small / normal / large / art_crop）。遇到 `png`、
  `border_crop`、`thumb` 等尺寸原样放过，不猜。
- **依赖站点没有严格 CSP。** 目前 phase.rs 生产站点（Cloudflare Pages 的 `_headers`
  与 GitHub Pages 预览）都只设缓存头，实测确认。书签靠 `javascript:` 执行，受
  `script-src` 管辖；若将来加了 CSP 会直接失效。同时若 CSP 限制 `img-src`，还需把
  `https://images.mtgch.com` 加进白名单。

## 隐私

脚本不发送任何网络请求，不读取页面内容，不访问 `localStorage` / cookie。

对自己的代码做过能力面审计，全部为 0 处：`fetch`、`XMLHttpRequest`、`sendBeacon`、
`WebSocket`、`import()`、`eval`、`new Function`、`GM_*`。唯一的模块级状态（「放弃」
集合）只存在于内存，刷新页面即清空。

唯一的对外请求是浏览器自己去取大学院废墟图床上的图片。

## 归属与许可

**代码**用 [MIT](LICENSE)，版权归 `haowen1993`。选它的理由：小工具、无专利风险，MIT 的
「随便用/改/再发，只要保留版权声明」就够了；而且 phase.rs 本身是 `MIT / Apache-2.0`
双许可，同向选 MIT 不会有将来合并回上游的许可障碍（Apache-2.0 多出的专利条款是给大
项目用的，这里属于多余复杂度）。

**卡图不在这份许可范围内**，它们各有归属：

- 卡图来自**大学院废墟**（[mtgch.com](https://mtgch.com)，图床 `images.mtgch.com`）。
  其中既包含官方简体中文印刷图，也包含社区制作的中文图；大学院废墟在 `zhs_image`
  字段里标注了每张图的来源（如 `官方`、`衍生物`、`TrentTouch`、`万智烽火`、`新版风云集`）。
- 本脚本**不复制、不缓存、不再分发**任何卡图，只在显示时把浏览器指向大学院废墟的图床。
  卡图的权利归属与使用条款由该站点及其上游来源决定。
- Magic: The Gathering 是 Wizards of the Coast 的商标。本脚本是非官方作品，与
  Wizards of the Coast 及 phase.rs 项目均无关联。

## 分发给别人

- **发文件**：把 `dist/install.html` 发过去（邮件、AirDrop、网盘都行）。对方用自己的
  浏览器打开，把按钮拖到书签栏就完事。文件纯自包含，不需要托管。
- **发一行字**：把 `dist/phase-rs-zh.bookmarklet.txt` 里那一整行（约 6.4 KB）连同
  「新建书签 → 把地址替换成这一行 → 打开 phase.rs 后点它」贴进聊天即可。
- **挂一个链接**：想给一群人用就把它挂到任意静态托管上分享 URL。
  例如用 GitHub Pages（`git subtree` 不一定可用，所以用临时目录建分支）：

  ```bash
  cd /tmp && rm -rf zh-pages && mkdir zh-pages && cd zh-pages
  git init -q -b gh-pages
  cp <本目录>/dist/install.html index.html
  git add . && git commit -m "docs: phase-rs-zh 安装页"
  git remote add origin <你的仓库地址>
  git push origin gh-pages   # 然后在仓库 Settings → Pages 里把 Source 选成 gh-pages
  ```

两点提醒：

1. **卡图是第三方社区站点提供的。** 分发给很多人等于把流量导向大学院废墟。脚本不缓存、
   不转发，每人每张图一次请求，与原本打 Scryfall 的流量同级；但量明显大了，最好知会
   对方一声。
2. **永远不要往分发包里放卡图文件。** 一旦放了，性质就从「运行时引用」变成「再分发」。

## 文件结构

```
phase-rs-zh/
├── README.md                               安装与日常使用（短）
├── NOTES.md                                本文件：设计、维护、分发（长）
├── src/content.js                          全部逻辑——唯一真源
├── dist/
│   ├── install.html                        安装页（拖拽 / 右键 / 复制地址）
│   ├── phase-rs-zh.bookmarklet.txt         书签地址（javascript: 一行）
│   └── phase-rs-zh.bookmarklet.js          未编码的压缩正文（供审阅）
├── docs/
│   ├── index.html                          GitHub Pages 入口，与 dist/install.html 逐字节相同
│   └── .nojekyll                           让 Pages 跳过 Jekyll 处理
├── test/
│   ├── content.test.mjs                    零依赖：纯逻辑 + 产物同源/等价校验
│   └── assembly.dom.mjs                    DOM 装配测试（vitest + happy-dom）
├── tools/
│   ├── build-bookmarklet.mjs               从 src/content.js 生成上面那些产物
│   ├── check-live.mjs                      对真实图床核对三级阶梯
│   └── check-app-data-coverage.mjs         用 phase.rs 的数据核对 URL 识别覆盖率
└── package.json  vitest.config.mjs         仅 DOM 测试需要
```

**为什么 `docs/index.html` 必须存在**：GitHub **不渲染**仓库里的 `.html` 文件——点
`dist/install.html` 只会看到源码。所以「README 里点一下就能拖按钮」必须靠 GitHub Pages
提供一个真正的网页，而 Pages 只支持从分支根目录或 `/docs` 发布。这份副本由构建脚本
生成、与 `dist/install.html` 逐字节相同，并由测试守着不许漂移。

两个测试文件用后缀区分运行器，不是随意命名：`node --test` **只收集 `*.test.mjs`**
（实测确认），所以 `assembly.dom.mjs` 不会被它捡走；而 vitest 的 `include` 被显式配成
`*.dom.mjs`。这样零依赖那套永远不需要 node_modules。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 完全没有变化 | 绝大多数情况是**忘了点书签**，或刷新后没再点。点了还没反应就看 Web Inspector 控制台有没有 `[phase-rs-zh] 已启用 v…`。 |
| 点了书签但控制台没有那行 | 浏览器拦掉了 `javascript:` 地址，或你没把它建成书签（地址栏直接粘贴会被浏览器去掉 `javascript:` 前缀）。 |
| 卡图变成文字占位 | 说明应用自己的降级链接手了。请记下卡名，并跑 `npm run check:live` 看映射是否已变化。 |
| 一部分卡是英文 | 正常：大学院废墟没有这些印刷的中文图，已按设计降到英文层。 |
| 网络面板出现 404 | 正常：那是中文层的判据，紧接着会降级。只有持续 404 且最终裂图才是问题。 |
