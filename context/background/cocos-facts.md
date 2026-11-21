# Cocos 工程速查

> 背景知识:本项目引擎配置与工程事实(2026-11-16 重组时合并原 decisions/000 与 knowledge/cocos-project-facts.md)。

## 工程配置

- Cocos Creator **3.8.7**,项目 uuid `55f7158d-0080-46ec-9514-652d84617a66`
- 创建时即选 2D 方案,3D 模块全关
- **启用模块**:2d / ui / graphics / mask / rich-text / affine-transform;physics-2d(**Box2D**)+ intersection-2d;tween / animation / particle-2d / spine-3.8 / dragon-bones;tiled-map / audio / video / webview / profiler / custom-pipeline
- **禁用**:全部 3D 模块、3D 物理、marionette、websocket、WebGPU(保留 webgl/webgl2)
- 渲染管线:custom-pipeline(非 legacy)

## 备选与影响(原决策 000)

- 备选方案:3D 方案(与定位不符,排除);内置 2D 物理(功能弱于 Box2D,未选)
- 影响:一切玩法基于 2D 体系,物理需求用 Box2D;**后期联网需在 项目设置→功能裁剪 重新启用 websocket**
- 配置源文件:`settings/v2/packages/engine.json`(修改后需重启编辑器生效)

## 目录与构建注意

- `context/` 与 `assets/` 平级,**不参与**资产导入与构建,可自由存放 markdown 与参考资料
- `.gitignore` 已排除 `library/ temp/ local/ build/ profiles/ native/ node_modules/ .vscode/ .idea/`;`context/`、`settings/`、游戏 `assets/` 均应入库
