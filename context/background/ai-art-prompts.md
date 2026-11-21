# 消除元素图像生成 Prompt 库(英文)

> 背景:基于认知地图确认方案(blind-box + split-symbol + emotional-anchor)生成,2026-11-17。
> 管线约束:**AI 只出整图,程序按垂直中线切半**做二分印花;每元素独占底色(颜色粗分类防线)。
> 关联:[ai-art-models.md](ai-art-models.md)(工具选择)。

## 1. 风格核(每条 prompt 的前缀,可复用)

```
flat vector illustration, cute rounded design, thick clean outlines, warm pastel
color palette, soft nostalgic 90s childhood summer mood, bold readable silhouette,
minimal interior details, sticker-style game asset, solid flat background,
no text, no watermark, no gradient background
```

## 2. 印花整图(核心资产,生成后程序切半)

布局约束块(`{TOY}`/`{COLOR}` 为变量):

```
single {TOY} perfectly centered in frame, front view, entire object fully visible
with even margins, object spans the vertical center line, composition designed
to be split into left and right halves, on a solid {COLOR} background
```

首批 8 玩具(TOY 描述 | 底色):

| # | 玩具 | TOY 描述 | 底色 |
|---|---|---|---|
| 1 | 玻璃弹珠 | clear glass cat-eye marble with a swirl of orange and teal ribbon inside | soft cream |
| 2 | 陀螺 | classic wooden spinning top painted with red and yellow stripes | pale blue |
| 3 | 竹蜻蜓 | bamboo dragonfly toy with two thin bamboo blades and a small wooden stick | mint green |
| 4 | 发条铁皮青蛙 | green tin wind-up frog toy with a metal winding key on its back, front view | pale yellow |
| 5 | 水枪 | retro plastic water squirt gun in coral red and white | lavender |
| 6 | 悠悠球 | classic wooden yo-yo with a blue star pattern on its face | peach |
| 7 | 泡泡棒 | bubble blowing wand with a small tray of soapy water | sky blue |
| 8 | 纸风车 | colorful paper pinwheel on a wooden stick | rose pink |

## 3. 盲盒盒体(堆叠元素本体)

**空白盒:**

```
2.5D casual game asset, a small blind box shaped like a mahjong tile, rounded
rectangle with visible thickness, cream white matte paper texture, subtle seam
line along the top face, soft drop shadow, flat cartoon render, warm afternoon
lighting, isolated on a solid dark green background, no text, no watermark
```

**带印花盒**(`{TOY PRINT}` 换为上表 TOY 描述):

```
[空白盒 prompt] + the top face shows a colorful flat print of {TOY PRINT},
the print fills the top face with an even margin
```

**牌堆观感验证:**

```
a pile of small blind boxes stacked in multiple overlapping layers like mahjong
tiles on a dark green felt table, only the top-layer boxes fully visible, lower
boxes partially covered showing plain box backs, cute casual game art, warm
afternoon light, soft shadows, no text
```

## 4. 风格一致性测试(4×2 九宫格)

```
a set of 8 childhood toy icons arranged in a neat 4x2 grid, each toy centered
in its own rounded square cell with a different solid pastel background color,
flat vector illustration, cute rounded design, thick clean outlines, warm
nostalgic summer mood, consistent style across all icons, no text
```

## 5. 负面 prompt(SD/FLUX 系工具)

```
text, watermark, letters, logo, photorealistic, 3D render, complex background,
gradient background, cropped object, multiple objects, thin outlines, harsh
contrast, dark night scene
```

## 使用提示

- **Midjourney**:首张满意图之后全部加 `--sref <URL>` 锁风格;常带 `--no text, watermark`
- **Recraft**:flat icon 预设,直接出 SVG,小尺寸印花可读性最佳
- **可读性验证**:1024 出图 → 缩到 96px 看轮廓是否可辨;不行则加强 "bold silhouette, minimal details" 权重
- 对称性:青蛙/陀螺/风车正面构图天然左右对称,切半后各有强特征;不对称物(水枪)靠底色+轮廓防线兜底
- 每张图记录:平台、prompt、seed、日期(商用合规留档)
