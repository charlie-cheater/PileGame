// ============================================================================
// LayoutPreview.ts — 布局审阅预览(临时审阅件,类比 PrintGallery)
// 优先加载 layoutJson(JsonAsset,堆叠编辑器导出格式);
// 未绑定时回落到 generateLayout 随机生成。占位配对(仅视觉,可解性归逆构造)。
// ============================================================================

import { _decorator, Component, log, JsonAsset } from 'cc';
import { Board } from '../core/Board';
import { generateLayout, RandomLayoutConfig } from '../core/LayoutGen';
import { LevelData, TILE } from '../core/tile';
import { computeDepths } from '../core/Depth';
import { PileView } from '../view/PileView';

const { ccclass, property } = _decorator;

/** 设计宽度(与工程设计分辨率一致) */
const DESIGN_W = 750;

const CFG: RandomLayoutConfig = {
    board: { w: 88, h: 80 },      // TILE 8×10 后 ×2,视觉尺寸不变
    layers: 4,                    // 多层(力矩约束参与上层放置)
    fillMode: 'capacity',         // 填满为止
    step: { x: 4, y: 5 },         // 半张步长(纵向 0.5×10=5,整数合法)
    mask: 'rect',                 // 蒙版关闭(全域)
    seed: 7,
};

/** 预览用单位映射(board 88×80 unit → 616×560px,TILE 8×10 后减半) */
const PREVIEW_UNIT_PX = 7;

interface EditorLayout {
    board: { w: number; h: number };
    tiles: Array<{ tileId: number; gx: number; gy: number; layer: number; subZ?: number }>;
}

@ccclass('LayoutPreview')
export class LayoutPreview extends Component {

    /** 编辑器导出的布局(JsonAsset);绑定时优先加载,否则随机生成 */
    @property({ type: JsonAsset })
    public layoutJson: JsonAsset | null = null;

    /** 力矩策略对比开关:false = razor(刀刃+面积门槛);true = strict(禁止刀刃) */
    @property
    public useStrictTorque = false;

    /** 单张牌显示宽度上限(px);缩放后不得超过 */
    @property
    public maxTilePx = 150;

    /** 版宽对齐目标 = 屏宽 + 此 margin(负值 = 两侧留白) */
    @property
    public widthMargin = -60;

    protected start(): void {
        try {
        const pile = this.node.getComponent(PileView);
        if (!pile) {
            log('[LayoutPreview] 缺少 PileView 组件');
            return;
        }
        // 调试开关(showDebugDepth/Exposure)由场景序列化值或 Inspector 控制,此处不强制

        if (this.layoutJson) {
            const data = this.layoutJson.json as EditorLayout;
            const rep = computeDepths(data.tiles);
            log(`[LayoutPreview] 加载布局 ${this.layoutJson.name}: `
                + `${data.tiles.length} 张 / maxDepth ${rep.maxDepth} / 开局可点 ${rep.waves[0]?.length ?? 0}`);

            // 版面实际包围盒 → 重定中心 + 适配缩放
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const t of data.tiles) {
                minX = Math.min(minX, t.gx);            minY = Math.min(minY, t.gy);
                maxX = Math.max(maxX, t.gx + TILE.w);   maxY = Math.max(maxY, t.gy + TILE.h);
            }
            const layoutW = maxX - minX;
            const layoutH = maxY - minY;
            const unitByWidth = (DESIGN_W + this.widthMargin) / layoutW;
            const unitByTile = this.maxTilePx / TILE.w;
            const unit = Math.min(unitByWidth, unitByTile);
            pile.unitPx = unit;
            pile.pivotX = (minX + maxX) / 2;
            pile.pivotY = (minY + maxY) / 2;
            log(`[LayoutPreview] 版面 ${layoutW}×${layoutH} unit · unitPx=${unit.toFixed(2)} `
                + `(宽适配 ${unitByWidth.toFixed(2)} / 牌宽上限 ${unitByTile.toFixed(2)})`);

            const level: LevelData = {
                board: data.board,
                elements: [{ elementId: 'x', displayName: '占位', color: '#E8543F' }],
                tiles: data.tiles.map((t, i) => ({
                    elementId: 'x',
                    variant: i % 2 ? 'R' : 'L',
                    gx: t.gx,
                    gy: t.gy,
                    layer: t.layer,
                    subZ: t.subZ,
                })),
            };
            pile.setup(new Board(level), level.elements);
            return;
        }

        const cfg = { ...CFG, torqueMode: this.useStrictTorque ? 'strict' as const : 'razor' as const };
        const result = generateLayout(cfg);
        log(`[LayoutPreview] 力矩=${cfg.torqueMode} 层量=${result.stats.layerCounts} `
            + `开局可点=${result.stats.openTiles} maxDepth=${result.stats.maxDepth}`);

        const level: LevelData = {
            board: CFG.board,
            elements: [{ elementId: 'x', displayName: '占位', color: '#E8543F' }],
            tiles: result.slots.map((s, i) => ({
                elementId: 'x',
                variant: i % 2 ? 'R' : 'L',
                gx: s.gx,
                gy: s.gy,
                layer: s.layer,
                subZ: s.subZ,
            })),
        };
        pile.setup(new Board(level), level.elements);
        } catch (e) {
            console.error('[LayoutPreview] 初始化异常', e);
            throw e;   // 调试期向上抛,便于浏览器控制台直接观察
        }
    }
}
