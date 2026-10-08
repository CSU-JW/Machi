# Machi UI 美术方向 + 图片加载 + 骰子动画 方案

> 配套文档：`docs/project-analysis-2026-10-04.md`
> 目标：解决「界面太像 AI 生成」、卡面图体积过大、缺少骰子动画三个问题，并与上一版的工程优化路线合并执行。

---

## 0. 现状诊断（先看数据）

### 0.1 图片体积实测

| 类型 | 数量 | 分辨率 | 单张 | 合计 |
|---|---|---|---|---|
| DLC 卡牌 + 地标 PNG | 15 | 1254×1254 | 2.3–2.8 MB | **37.6 MB** |
| 原版卡牌 JPG | 15 | 768×768 | 144–207 KB | 2.6 MB |
| 合计 | 30 | — | 平均 1.34 MB | **40.2 MB** |

而在界面里，它们最大只被显示为：
- `owned-card` 58px 宽（`public/style.css:186`）
- 市场货架 / 购买格约 120–180px
- 卡牌详情弹窗约 320px

**结论：图片被放大了 4–8 倍使用，PNG 又没针对 Web 压缩，属于典型的「拿生成原图直接上线」。** 首屏慢、切页慢、流量大，主要就是这 15 张 PNG。

### 0.2 现有视觉语言为什么「AI 味」

当前 `public/index.html` 内联样式 + `public/style.css` 组合出的风格是：
- 奶油/米黄/木色 + 金色 + 绿色的大面积暖色；`body` 是三层渐变 + 网格叠加 + `mix-blend-mode`（`style.css:37-55`）。
- 大量 14–18px 圆角、圆角胶囊、`backdrop-filter: blur()`、外发光阴影（`style.css:57-139`）。
- emoji 当图标使用（🎲 🪙 🏛️ 🤖 👁 ⚡ 🌊 …），品牌标题用 Georgia 衬线（`style.css:63-68`）。
- 4 种卡牌色（绿/蓝/红/紫）其实已经是一套很好的信息色，但被背景渐变和装饰抢夺了注意力。

这些特征叠加起来，就是常见的「AI 生成的网页」观感：**暖色渐变 + 玻璃卡片 + 大圆角 + emoji 图标 + 装饰性阴影，信息层级反而被削弱。** 不是不好看，是缺少一个明确、克制、可复述的美术方向。

---

## 1. 美术方向：两步走

### 1.1 推荐路线

**UI 外壳走「现代桌游台面」，卡面插画走「海港木刻版画 / 旅行海报」。**

这是关键取舍：**界面要安静、密度高、可扫读；卡面要表现力强、成系列。** 让插画去承担情绪，让 UI 去承担操作，就不会再「全屏都是 AI 味」。

| 层 | 风格 | 关键词 |
|---|---|---|
| UI 外壳 | 现代桌游台面 | 深青绿台面、白纸卡、清晰分区、线性图标、无渐变装饰 |
| 卡面插画 | 海港木刻版画 / 复古旅行海报 | 限量 5 色、粗轮廓、套色错位、木纹/网点颗粒 |
| 地标插画 | 同上，但更「建筑海报」 | 对称构图、仰视、剪影明确 |
| 动效 | 物理桌游感 | 发牌、翻面、木牌盖章、骰子滚动 |

不建议走「像素风」（资产量大、中文可读性差），也不建议继续走「奶油治愈风」（正是当前 AI 味的来源）。

### 1.2 色彩 token（先定死，再画图）

```css
:root {
  /* 外壳：冷色中性 + 深青绿台面，避免奶油/米黄主导 */
  --ink:        #16202B;  /* 主文字 */
  --slate:      #2C3A47;  /* 次级文字/边框 */
  --muted:      #6B7A89;  /* 弱化文字 */
  --surface:    #FFFFFF;  /* 面板 */
  --surface-2:  #F4F6F8;  /* 次面板/条纹 */
  --line:       #D8DEE4;  /* 分割线 */
  --table:      #0F3B47;  /* 台面：深青绿 */
  --table-2:    #0B2E38;  /* 台面暗部 */
  --accent:     #D97706;  /* 金币/当前回合强调 */

  /* 四类卡牌：沿用现有语义色，作为唯一彩色来源 */
  --card-self:  #2F855A;  /* 绿：自己回合收益 */
  --card-any:   #2B6CB0;  /* 蓝：任意玩家收益 */
  --card-other: #C53030;  /* 红：向他人收款 */
  --card-six:   #6B46C1;  /* 紫：每人限一张 */
}
```

约束：
- 全局最多 1 处渐变（骰子/金币微高光），其余用纯色与细边框。
- 面板圆角 8–12px，卡牌 10px，胶囊只用于状态徽章。
- 去掉 `backdrop-filter` 玻璃感，改为实色面板 + 1px 边框。
- 主图标全部换线性图标（lucide 风格），emoji 只保留在聊天内容里。

### 1.3 字体

- 标题/品牌：`Noto Serif SC`（思源宋体）或 `ZCOOL XiaoWei`，字重 600–700。
- 正文/UI：`Noto Sans SC` + 系统 sans 兜底；数字用 `font-variant-numeric: tabular-nums`。
- 不再用 Georgia 配中文，避免中英衬线错位。

---

## 2. GPT 效果图提示词（可直接复制）

### 2.1 使用建议（很重要）

1. **先让 GPT 出「风格基调图」，不要直接出带中文的成品 UI。** 图像模型对中文 UI 文本几乎必然糊字，硬出会得到一堆假字，反而更 AI 味。
2. 正确流程：生成 3 张风格基调图 → 选定 1 张 → 把选定图作为参考图（image reference）再生成分屏效果图 → 最后在代码里实现真实 UI，用 Playwright 截图对比迭代。
3. 让模型只画「布局 + 材质 + 色彩 + 图标风格」，文本用 `[占位]` 或英文短标签，中文在代码里叠加。
4. 每次生成固定 seed，并复用同一段 negative prompt，系列才统一。

### 2.2 总纲提示词（风格基调图）

```text
Create a high-fidelity visual style keyframe for a 4-player online board game
named "Dream Town" (梦想小镇). This is a modern tabletop game interface, not a
marketing landing page.

ART DIRECTION
- Quiet, information-dense product UI shell + expressive illustrated cards.
- Table surface: deep teal felt (#0F3B47) with subtle woven texture.
- Cards: crisp white paper with strong color-coded frames (green #2F855A,
  blue #2B6CB0, red #C53030, purple #6B46C1).
- UI chrome: off-white surfaces, 1px light-gray borders, slate text.
- Corner radius 8-12px. Flat color, thin borders, restrained soft shadow.
- Line icons in lucide style. No emoji as UI icons.

COMPOSITION
- 16:9 desktop game screen.
- Four player town boards arranged 2x2, each with money, owned cards and four
  framed landmark slots.
- Central dice tray with two physical-looking dice.
- Right-side collapsible chat drawer.
- Bottom action bar for roll / buy / build / end turn.
- Top turn banner with current player.

NEGATIVE
no cream/beige dominant palette, no purple-blue gradient background,
no glassmorphism, no floating glass cards, no neon glow, no decorative orbs,
no bokeh, no emoji, no fake Chinese text, no lorem ipsum, no watermark,
no photorealistic people, no cluttered decorations.

Render as a professional product design keyframe, flat vector + subtle paper
grain, crisp spacing, realistic information hierarchy. 16:9.
```

### 2.3 分屏效果图提示词

**A. 登录 / 大厅**

```text
Same art direction as the reference. Design the lobby screen of the board game
"Dream Town". Left: a quiet sign-in card with three tabs (account / register /
guest), clean form fields, no decorative hero. Right: a grid of room cards, each
showing room number, player count, DLC tag, status pill and one primary join
button. Deep teal table background, off-white panels, slate typography, line
icons only. Show one "single-player test room" card with a subtle test badge.
No emoji, no gradient, no glassmorphism, no fake text. 16:9.
```

**B. 房间等待 / 席位 + 聊天**

```text
Same art direction. Design the waiting room screen. Four player seats in a
clean 2x2 or 1x4 row, each seat showing avatar, nickname, role tag, connection
state; below them a separate spectator strip. Right side: a chat panel with
messages, a spectator tag on spectator messages, and a 300-character input.
Host-only controls: DLC toggle, bot difficulty select, add bot, start game.
Off-white panels on deep teal table, 1px borders, 10px radius, line icons.
No emoji, no gradient, no glassmorphism. 16:9.
```

**C. 对局主界面（最重要的一张）**

```text
Same art direction. Design the main 4-player game screen of "Dream Town".
Top: turn banner showing whose turn it is and current round. Center: dice tray
with two wooden dice, and a clearly readable result badge. Left/center:
four player town boards in a 2x2 grid, each with money, owned mini-cards,
and four landmark slots (unbuilt = muted outline, built = full color).
Bottom: action bar with roll 1 / roll 2 / buy / build / end turn, disabled
states clearly visible. Right: collapsible chat drawer. Cards use the four
semantic frame colors. Keep it dense and scannable, not decorative.
No emoji, no gradient, no glassmorphism, no fake Chinese text. 16:9.
```

**D. 卡牌详情 / 购买弹窗**

```text
Same art direction. Design a card detail modal for the game. Large illustrated
card on the left with a clean frame containing point badge, cost badge,
card name and effect text; right side shows legality status ("can buy",
"already owned", "sold out"), a discount source selector, and confirm/cancel
buttons. The illustration is a limited-palette woodblock travel-poster style.
The frame is CSS-like, crisp, not a photo. Deep teal dimmed backdrop.
No emoji, no gradient, no watermark. 4:3.
```

**E. 移动端**

```text
Same art direction, mobile portrait 390x844. Design the game screen for a
phone: turn banner, compact dice tray, horizontally scrollable player boards,
bottom action sheet, chat as a slide-up drawer. Tap targets at least 44px.
Dense but readable. No emoji, no gradient, no glassmorphism. 9:19.5.
```

**F. 骰子动画分镜**

```text
Same art direction. Create a 6-frame storyboard of a physical dice roll on a
deep teal felt table. Frame 1: dice at rest. Frame 2-4: dice tumbling in the
air with motion blur and a soft contact shadow. Frame 5: dice landing.
Frame 6: dice settled, result readable from the top face. Two dice, wooden
ivory material with dark pips, top-left light, consistent camera.
No text, no gradient background, no watermark.
```

### 2.4 Negative prompt（每次追加）

```text
no cream dominant, no beige, no sand, no tan, no brown-dominant palette,
no purple-blue gradient, no glassmorphism, no frosted glass, no floating cards,
no neon, no glow, no orbs, no bokeh, no emoji, no fake Chinese characters,
no garbled text, no watermark, no logo, no photorealistic humans,
no cluttered decoration, no 3D render of a phone, no marketing hero layout
```

---

## 3. 卡面插画提示词 + 30 张 shot list

### 3.1 卡面总模板

```text
Square 1:1 illustration for a tabletop board game card.
SUBJECT: [卡牌主题]
SCENE: [场景与动作]
COMPOSITION: single clear subject, centered, strong silhouette, generous
negative space at the top, readable at 64px.
STYLE: modern woodblock print mixed with mid-century travel poster; bold
shapes, limited 5-color palette (deep teal #0F3B47, vermilion #C8452F,
mustard #E3A72F, ink #16202B, warm paper #F3EBDD); subtle risograph grain,
slight ink misregistration, flat perspective, soft top-left light.
CONSISTENCY: same camera, same line weight, same grain as the whole series.
NO text, NO border, NO frame, NO logo, NO watermark, NO photorealism,
NO anime, NO 3D render, NO emoji.
```

> 卡框、点数、价格、名字、效果全部由 CSS/HTML 叠加，**不要让图片生成文字**。这样既能避免糊字，也能让同一张插画复用到图鉴、手牌、弹窗三个尺寸。

### 3.2 系列一致性技巧

1. 先生成 1 张「风格参考卡」（建议用麦田或港口），确认色调与颗粒。
2. 之后每张都把这张作为 image reference 传入，并固定 seed。
3. 批量时按「同色系一起生成」，绿色卡一起、蓝色卡一起，减少色偏。
4. 每张只画「一个主体 + 一个动作」，卡片在 64px 下也要能辨认。

### 3.3 Shot list（26 张建筑 + 4 张地标）

| 卡牌 | SUBJECT / SCENE | 主色 |
|---|---|---|
| 麦田 wheat | 金色麦浪中的小木牌与风车，远景地平线 | mustard |
| 牧场 ranch | 木栅栏、奶牛剪影、山坡草地 | deep teal + paper |
| 面包店 bakery | 街角面包店，暖黄灯光从橱窗透出，法棍剪影 | mustard + vermilion |
| 咖啡店 cafe | 海边咖啡馆，遮阳棚、咖啡杯冒热气 | vermilion |
| 便利店 convenience | 24 小时便利店门头，夜灯，货架剪影 | deep teal + mustard |
| 林场 forest | 层叠针叶林、伐木小道、远处山脊 | deep teal |
| 体育馆 stadium | 圆形看台俯瞰，灯光柱，跑道 | deep teal + vermilion |
| 电视塔 tvStation | 高耸电波塔，同心圆电波，黄昏天空 | ink + mustard |
| 商场 mall | 玻璃穹顶百货，扶梯与人流剪影 | deep teal + paper |
| 奶制品工厂 dairy | 白色奶罐、管道、奶牛剪影 | paper + deep teal |
| 果园 orchard | 果树行列，果篮，坡地 | vermilion + mustard |
| 矿山 mine | 矿车、矿洞入口、矿石闪光 | ink + mustard |
| 奶茶店 teaHouse | 珍珠奶茶杯、霓虹小巷、蒸汽 | vermilion + deep teal |
| 工艺品工厂 craft | 木工台、齿轮、陶轮与工具 | ink + vermilion |
| 农产品工厂 farm | 谷仓、传送带、麦袋与蔬果 | mustard + vermilion |
| 花店 florist | 门口花桶、花束、玻璃橱窗 | vermilion + paper |
| 渔场 fishery | 海上渔网、浮标、渔船剪影 | deep teal |
| 书店 bookshop | 窄巷书店、堆叠书脊、暖灯 | ink + mustard |
| 公交站 busDepot | 海边公交站牌、长椅、远处巴士 | deep teal + mustard |
| 港口 harbor | 码头吊机、货箱、灯塔 | deep teal + vermilion |
| 博物馆 museum | 古典柱廊、鲸骨/展柜、台阶 | paper + ink |
| 海鲜市场 seafoodMarket | 冰台、鱼获、遮阳棚、海鸥 | deep teal + vermilion |
| 水族馆 aquarium | 玻璃隧道、鱼群、蓝色水光 | deep teal |
| 温泉旅馆 spa | 石池、热气、松枝、灯笼 | vermilion + deep teal |
| 夜市 nightMarket | 灯笼长街、摊位、烟火气 | vermilion + mustard |
| 科技园 techPark | 现代园区、玻璃楼、风车/太阳能板 | deep teal + paper |
| 火车站 train（地标） | 小镇车站、铁轨透视、站台钟 | ink + mustard |
| 广播中心 radio（地标） | 山顶广播塔、同心电波、夜空 | ink + deep teal |
| 商业中心 mallC（地标） | 城市核心商圈、楼群天际线 | deep teal + paper |
| 游乐园 park（地标） | 摩天轮、旋转木马、彩旗 | vermilion + mustard |

> 地标建议额外生成 1 张「未建成」灰阶版，或在 CSS 里用 `filter: grayscale(1) opacity(.45)` 处理，不必多画一套。

### 3.4 骰子素材提示词（如果要图片）

优先用 CSS 3D 骰子（见第 4 节），**不需要图片**。只有当你要做 2D 翻页动画时，才需要一个骰面图集：

```text
An orthographic texture atlas of six dice faces, arranged 3 columns x 2 rows,
on a pure white background, evenly spaced, no gaps. Each face is an ivory
wooden die face with rounded edges and dark pips, lit from the top-left,
straight-on orthographic view, no perspective, no shadow, no text, no border.
512x512 per face, crisp edges, consistent lighting. Game asset sheet.
```

如果做 2D 掷骰翻页动画：

```text
A 12-frame sprite sheet, 6 columns x 2 rows, animation of two ivory wooden
dice tumbling on a deep teal felt table and settling. Transparent background,
consistent camera and lighting, no text, no watermark. Each frame 512x512.
```

---

## 4. 骰子动画方案（推荐 CSS 3D）

### 4.1 为什么不用视频/GIF

- GIF 体积大、质量差；视频需要额外解码与首帧等待。
- 结果必须与服务器一致，预渲染视频无法映射到任意点数。
- CSS 3D 骰子体积极小（几 KB CSS），可清晰映射 1–6 任意结果，还能随主题换色。

### 4.2 数据结构（服务端已具备）

服务端已经是权威结果：`g.dice = { count, values, sum }`（`engine.js:rollDice`）。前端只需在状态变更时驱动动画：

```js
// 伪代码
const key = `${game.dice.count}:${game.dice.values.join('+')}`;
if (key !== lastDiceKey) {
  if (isReconnect || isSpectatorInitialSync) renderSettledDice(game.dice); // 不重播
  else rollDiceAnimation(game.dice);                                     // 播动画
  lastDiceKey = key;
}
```

### 4.3 DOM 结构

```html
<div class="dice-tray" aria-live="polite">
  <div class="die" data-value="1">
    <div class="face f1">…pips…</div>
    <div class="face f2">…</div>
    <div class="face f3">…</div>
    <div class="face f4">…</div>
    <div class="face f5">…</div>
    <div class="face f6">…</div>
  </div>
  <div class="die">…</div>
  <span class="dice-sum">7</span>
</div>
```

骰点用 CSS grid 排 1–9 个圆点，不用图片：`f1` 中心 1 点、`f2` 对角 2 点、`f3` 对角 + 中心、`f4` 四角、`f5` 四角 + 中心、`f6` 两列各 3 点。

### 4.4 动画规格

| 项 | 值 |
|---|---|
| 翻转时长 | 760ms（两颗骰子第二颗延迟 60ms 起手） |
| 缓动 | `cubic-bezier(.2,.8,.25,1)` |
| 过程 | 随机 720°+ 翻滚 + 轻微上抛与落桌回弹 |
| 落定 | 用 `data-value` 查旋转表，精确停到目标面 |
| 组合 | 两骰结果分别对应两个 cube，不把 sum 当单骰 |
| 重投 | 加一次更短的 `.reroll`（520ms），配合「重投」标签 |
| 无障碍 | `prefers-reduced-motion: reduce` → 100ms 淡入直接显示结果 |
| 音效 | 可选 `dice-roll.mp3` ≈ 10–20KB，默认静音 + 开关 |
| 播报 | `aria-live` 输出「掷出 7 点（3 + 4）」 |

### 4.5 骰子旋转映射表（关键实现）

给每个面预置一个「朝上」的旋转，骰子停在哪个值就应用哪组 transform：

```js
const FACE_ROTATION = {
  1: 'rotateX(0deg) rotateY(0deg)',
  2: 'rotateX(-90deg) rotateY(0deg)',
  3: 'rotateX(0deg) rotateY(-90deg)',
  4: 'rotateX(0deg) rotateY(90deg)',
  5: 'rotateX(90deg) rotateY(0deg)',
  6: 'rotateX(180deg) rotateY(0deg)',
};
```

流程：先给 cube 一个随机大角度（`rolling`），动画结束的瞬间把 transform 设为「随机角度 + 目标面角度」并写死，保证最终面正确。

### 4.6 与流程的衔接

- 掷骰后如果存在 `askReroll`（游乐园），动画结束再显示「接受 / 重投」按钮；或允许提前点，但动画继续。
- 6 点有体育馆/电视塔/商场选择时，骰子停在台面上保持可见，不要收走。
- 托管/超时自动掷骰时，用同一个动画，但顶部横幅标注「托管中」。
- 观战者与重连进房：只显示静态结果，不重播，避免每个人进来都滚一次。

---

## 5. 图片加载优化方案（可量化）

### 5.1 目标预算

| 指标 | 现状 | 目标 |
|---|---|---|
| 30 张卡面 + 地标总体积 | 40.2 MB | **≤ 3 MB** |
| PNG 单张 | 2.3–2.8 MB | 512px WebP q78 ≈ 35–60 KB |
| JPG 单张 | 144–207 KB | 512px WebP q78 ≈ 25–45 KB |
| 首屏（对局界面）图片字节 | 数 MB | **≤ 500 KB** |
| LCP（4G，桌面） | 未测，预计 > 4s | ≤ 2.0s |
| CLS | 未测 | < 0.05 |

按 512px WebP q78 估算：30 张 × 40–55 KB ≈ **1.2–1.7 MB**，相比现在缩小约 **25–30 倍**。如果需要 AVIF，可再降 30–40%，但要注意兼容回退。

### 5.2 分层出图，而不是一张原图打天下

| 用途 | 尺寸 | 格式 | 质量 | 估算 |
|---|---|---|---|---|
| 手牌小卡 / 列表缩略 | 256×256 | WebP | q72 | 12–22 KB |
| 市场格 / 卡牌弹窗 | 512×512 | WebP | q78 | 35–60 KB |
| 备用回退 | 512×512 | JPEG | q80 | 45–75 KB |
| 原始母版 | 1254×1254 | PNG | — | 不部署，只留 `assets-src/` |

规则：**原始母版进 `assets-src/`（加入 `.gitignore`，不进部署包），部署目录只放 256/512 两档 WebP + JPEG 回退。**

### 5.3 生成管线

用 sharp / Squoosh CLI 做一次性转换，写进 `package.json` 脚本，避免手工导出：

```json
{
  "scripts": {
    "assets": "node scripts/build-images.mjs"
  }
}
```

```js
// scripts/build-images.mjs（示意）
import sharp from 'sharp';
import { readdir, mkdir } from 'node:fs/promises';

const jobs = [
  { src: 'assets-src/cards',   out: 'public/assets/cards',   sizes: [256, 512] },
  { src: 'assets-src/dlc',     out: 'dlc1/assets/cards',     sizes: [256, 512] },
  { src: 'assets-src/landmarks', out: 'public/assets/landmarks', sizes: [256, 512] },
];

for (const job of jobs) {
  await mkdir(job.out, { recursive: true });
  for (const file of await readdir(job.src)) {
    if (!/\.(png|jpg|jpeg)$/i.test(file)) continue;
    const id = file.replace(/\.[^.]+$/, '');
    for (const size of job.sizes) {
      await sharp(`${job.src}/${file}`)
        .resize(size, size, { fit: 'cover' })
        .webp({ quality: size === 256 ? 72 : 78, effort: 5 })
        .toFile(`${job.out}/${id}-${size}.webp`);
    }
  }
}
```

上线前跑一次 `npm run assets`，并把产物纳入版本管理或构建产物。

### 5.4 前端加载策略

```html
<picture>
  <source type="image/webp"
          srcset="/assets/cards/wheat-256.webp 256w,
                  /assets/cards/wheat-512.webp 512w"
          sizes="(max-width: 620px) 72px, 120px">
  <img src="/assets/cards/wheat-512.jpg"
       width="512" height="512"
       loading="lazy" decoding="async" alt="麦田">
</picture>
```

- **只对首屏可见的卡**用 `eager`：自己的初始麦田/面包店、4 个地标。
- 其余全部 `loading="lazy"` + `decoding="async"`。
- 每个 `<img>` 写死 `width/height` 或容器 `aspect-ratio`，消除 CLS。
- 卡牌详情弹窗才请求 512 版；列表只请求 256 版。
- 图片路径带内容哈希或版本号：`wheat-512.webp?v=<hash>`。

### 5.5 服务端配合

当前 `serveStatic`（`server.js:65-135`）需要改三处：

1. DLC 白名单正则现在只允许 `.png` 和 `[a-zA-Z]+`：
   `/^\/dlc1\/assets\/cards\/[a-zA-Z]+\.png$/`（`server.js:98`）。
   要扩展为 `\.(png|webp|avif|jpg)$`，并允许连字符（例如 `tea-house`）。
2. 给静态资源加缓存头：
   `Cache-Control: public, max-age=31536000, immutable`（仅对带哈希/版本的文件）。
3. 给 JS/CSS 加 gzip/brotli（图片本身已压缩）；加 `ETag`。

### 5.6 顺带解决的关联问题

- 上一版分析里的 **全量 `state` 广播**会拖慢每次操作后的 UI 更新；图片变小后，仍需把日志改增量/截断（`server.js:188-213`）。
- **规则目录化**后，卡框、点数、价格、文字都由元数据生成，图片只负责插画；换画风不碰业务代码。
- 如果后续加 **PWA**，用 service worker 预缓存 256 缩略图，二次进房几乎瞬开。

---

## 6. UI 重构清单（去 AI 味的具体动作）

### 6.1 结构

1. 把 `public/index.html` 里的内联 `<style>` 合并进 `public/style.css`，只保留一份。
2. 引入 `public/assets/icons.svg` 线性图标 sprite（骰子、金币、皇冠、眼睛、机器人、聊天气泡、设置、叉、勾等约 20 个），替换所有 emoji。
3. 布局改为 12 栅格：左侧对局区 + 右侧聊天栏；4 人时 2×2 玩家板；骰子托盘吸顶；操作栏固定在内容区底部。
4. 卡牌组件分三层：插画（图片）+ 卡框（CSS 色带）+ 信息层（点数/价格/名字/效果）。

### 6.2 组件清单

`Button`（primary / secondary / danger / icon）、`Tabs`、`Seat`、`PlayerBoard`、`Card`、`LandmarkSlot`、`Badge`、`ChatBubble`、`Modal`、`Toast`、`TurnBanner`、`DiceTray`、`Countdown`。

### 6.3 动效清单（150–250ms，全部尊重 `prefers-reduced-motion`）

- 发牌：卡牌从牌堆位置 stagger 入场（30ms 间隔）。
- 悬停：卡牌上浮 2px + 阴影收紧。
- 金币变化：数字 count-up（不是滚动抽奖）。
- 建设地标：盖章/压暗→点亮，配一次短促缩放。
- 回合切换：横幅从右滑入。
- 骰子：第 4 节。

### 6.4 明确禁止

- 大面积暖色渐变背景、装饰性 orb/bokeh、玻璃拟态。
- emoji 当功能图标。
- 所有容器都用 16–18px 大圆角。
- 同一屏出现 3 种以上阴影强度。
- 把卡牌做成「漂浮玻璃卡片」。

---

## 7. 与上一版工程计划的合并执行顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| Week 1 前半 | 定美术方向 → 生成风格基调图 → 确定 token；同时修 P0（`__proto__` 崩溃）与 P1（掉线托管） | 无 |
| Week 1 后半 | 用 2 张卡（麦田/港口）跑通 WebP 管线，测出真实体积；生成 30 张 shot list 的首批 6 张 | 美术方向 |
| Week 2 | 全量出图 + 转换 + `<picture>` + 懒加载 + 缓存头；UI 外壳重构（图标/布局/卡框） | 图片管线 |
| Week 3 | CSS 3D 骰子动画 + 音效 + reduced-motion + 托管/重连状态；规则目录化启动 | UI 重构 |
| Week 4 | 规则目录迁移 + 日志瘦身 + Web Vitals 观测 + 移动端适配 + 无障碍检查 | 前几阶段 |

**关键点：图片优化与 UI 重构可以并行，但骰子动画最好在 UI 外壳定稿后做，否则托盘尺寸、配色、圆角都要返工。**

---

## 8. 验收标准

**性能**
- 30 张卡面 + 地标总量 ≤ 3 MB；单张 512 WebP ≤ 60 KB。
- 首次进入对局界面，图片请求字节 ≤ 500 KB；LCP ≤ 2.0s（4G 模拟）；CLS < 0.05。
- 所有图片有 WebP + JPEG 回退，路径带版本号，响应带 immutable 缓存头。

**视觉**
- 随机找 3 个人，能用同一句话描述风格；UI 主界面不出现 emoji 图标、无玻璃拟态、无装饰渐变。
- 卡面在 64px、120px、320px 三个尺寸下都能辨认主体。
- 四类卡牌颜色仍是唯一的主要彩色来源，信息层级清晰。

**骰子**
- 动画最终面与服务端 `game.dice.values` 完全一致；重投播短版；重连不重播。
- `prefers-reduced-motion` 下直接显示结果。
- 两颗骰子分别渲染，sum 只作为结果徽章，不把 sum 当成一颗骰子。

**工程**
- 静态资源走 `npm run assets` 生成，不手工导出。
- P0 的非法 id 崩溃、P1 的掉线卡死有回归测试。
- 规则元数据只有一份，客户端不再手抄 `CARD_COSTS/CARD_POINTS/SIX_CARDS`。

