# AI 美术素材生成模型推荐

> 背景知识:2026-11-17 调研(网络检索),针对本项目需求(2D 扁平、盲盒印花、玩具图标、风格一致性)筛选。
> 关联:STATUS 未决 #5(美术资源来源);`image-resources.md`(传统素材库)。

## 按用途推荐

| 用途 | 推荐 | 理由 |
|---|---|---|
| 风格定调/概念探索 | Midjourney V8、即梦(Seedream) | MJ 艺术质量标杆,V8 原生 2K、提速 5 倍;即梦中文语感好、生成快、试错成本低 |
| 整套素材一致性 ⭐ | Scenario、Leonardo、即梦智能画布 | Scenario 游戏资产管线特化,**用自己的图训练专属风格模型**后批量产出;即梦智能画布:多图融合/局部重绘/同画布拼接 |
| 扁平矢量图标/印花 | Recraft | AI 矢量生成代表,可输出 SVG;无损缩放、小尺寸可读(契合二分符号 M5 远读性) |
| 迭代修改/局部编辑 | ChatGPT 图像、Gemini 图像编辑 | 指令式改图("换色/去背景")最顺 |
| 写实材质(木纹/绒布) | FLUX.2 | 照片级真实感,适合槽位托盘木纹、桌面绒布贴图 |
| 本地部署/免费批量 | FLUX.2 + ComfyUI | 可控性最强、可训 LoRA、批量免费;学习成本高 |
| 3D(备查,当前不需要) | Meshy / Tripo / 混元3D / TRELLIS | 纯 2D 项目仅备查 |

## API 可用性(2026-11 核实)

- **Midjourney:无官方 API**(仅 Discord/网页);市面"MJ API"均为第三方代理(PiAPI/useapi/GoAPI/自建 midjourney-proxy),有 ToS 与稳定性风险
- **有官方 API、适合管线化批量生产的**:即梦/Seedream(字节火山引擎,⭐国内首选)、通义万相(阿里 DashScope)、Recraft(矢量)、FLUX.2(BFL/fal/Replicate)、OpenAI gpt-image、Gemini 图像
- **结论**:MJ 用于人工风格定调阶段;批量生产阶段用即梦 API + Recraft API 搭管线(配合"AI 出整图 → 程序切半")

## 本项目建议工作流

1. **定调**:MJ/即梦按"童年玩具 + 扁平 + 夏日暖光"出 3~5 套风格样板,用户挑一套
2. **固化风格**:样板喂 Scenario 训练专属风格模型(或 MJ `--sref` 风格参考)
3. **批量产出**:AI 生成**完整玩具图** → **程序按天然中线切两半**做二分印花(不要让 AI 直接画半图,拼合精度无保障;统一切分规则保证拼合动画对齐)
4. **图标矢量线**:印花/图鉴图标走 Recraft 出 SVG;背景/UI 大件走 MJ/FLUX
5. **合规**:商用前核对各平台条款(MJ 付费版可商用;FLUX dev 权限窄于 pro;国产工具看会员等级);存档每张图生成来源

## 检索来源

- Sitepoint: Top 6 AI Image Generators in 2026 — sitepoint.com/top-6-ai-image-generators-in-2026-features-strengths-and-limits
- 知乎: 2026 年 15 款 AI 图片生成工具推荐 — zhuanlan.zhihu.com/p/2052425447049369386
- CSDN: AIGC 工具助力 2D 游戏美术全流程 — opc.csdn.net/696df75a437a6b4033691a30.html
- 掘金: 生图模型 PK(万相/即梦/可灵)— juejin.cn/post/7462390806582657033
- Ludo.ai / Blyth.ai / Sonilo 2026 游戏资产生成器横评
