# 对局背景图

> 当前已接入：`board.webp`（由 `复古四角海港群岛地图.png` 压缩而来，1672×941，153.8KB），
> `style.css` 里 `.board` 的 `--board-image` 已指向它。

把生成好的背景图放到这个目录，文件名建议 `board.webp`（或 `board.png`），
然后在 `public/style.css` 里把 `.board` 的 `--board-image` 换成：

```css
.board { --board-image: url('/assets/board/board.webp'); }
```

## 规格

- 16:9 横屏，2560×1440（或 1920×1080）。
- 深青绿主色，四周有海岸/地图装饰，**中间保持安静**（公共牌堆会盖在上面）。
- 四个角各留一块较空的区域，给四名玩家的面板。
- 不要出现文字、UI 控件、卡牌、骰子、人物、logo、水印。
- 低对比、弱细节，保证卡牌和文字读得清。

## 推荐提示词（地图棋盘）

```text
Top-down illustrated board game background for a 4-player seaside town game.
16:9, 2560x1440. Deep teal ocean base with a large calm open plaza in the center
(leave it empty and uncluttered for UI cards), four empty corner districts
(top-left, top-right, bottom-left, bottom-right) that read as four player areas,
a decorative coastal map border with tiny islands, boats and small buildings
along the edges. Flat vector illustration, limited palette
(deep teal #0F3B47, cream #F3EBDD, vermilion #C8452F, mustard #E3A72F,
ink #16202B), subtle paper grain, risograph texture, soft top-left light.
No text, no UI, no cards, no dice, no characters, no watermark, no logo,
no photorealism, no 3D render, no gradient sky.
```

## 备选提示词（桌布质感）

```text
Seamless dark teal felt table texture for a board game, 16:9, 2560x1440.
Subtle woven fabric grain, slightly lighter calm center, four softly darker
corners, no objects, no text, no logo, no watermark, low contrast, soft
top-left light, photorealistic texture but flat and even.
```

