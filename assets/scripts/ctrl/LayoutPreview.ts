// ============================================================================
// LayoutPreview.ts — 布局审阅预览(临时审阅件,类比 PrintGallery)
// 优先加载 layoutJson(JsonAsset,堆叠编辑器导出格式);
// 未绑定时回落到 generateLayout 随机生成。占位配对(仅视觉,可解性归逆构造)。
// ============================================================================

import { _decorator, Component, log, JsonAsset } from 'cc';
import { Board } from '../core/Board';
import { generateLayout, RandomLayoutConfig } from '../core/LayoutGen';
import { LevelData, TILE, ElementDef } from '../core/tile';
import { computeDepths } from '../core/Depth';
import { fillSlots } from '../core/RandomFill';
import { buildMahjongElements } from '../core/MahjongSet';
import { PileView } from '../view/PileView';
import { attachAgentDebug } from '../agent/AgentDebug';

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

    /** 仿真玩家代理:选中交互 debug(点选牌显示效能/匹配消耗;默认开启) */
    @property
    public agentDebug = true;
    /** 代理可视化:静态叠加层(边框/角标/关系线/幽灵/统计行;默认关闭) */
    @property
    public agentShowStatic = false;

    /** 单张牌显示宽度上限(px);缩放后不得超过 */
    @property
    public maxTilePx = 150;

    /** 版宽对齐目标 = 屏宽 + 此 margin(负值 = 两侧留白) */
    @property
    public widthMargin = -60;

    /** 随机填充种子(麻将 27 牌型,FULL 全图匹配;0 = 每次随机) */
    @property
    public fillSeed = 7;

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

            // 随机填充:真实麻将牌面(FULL 全图匹配),替代占位配对
            const elements = buildMahjongElements();
            const level: LevelData = {
                board: data.board,
                elements,
                tiles: fillSlots(data.tiles, { elements, seed: this.fillSeed || undefined }),
            };
            log(`[LayoutPreview] 随机填充 ${level.tiles.length} 张`
                + `(seed=${this.fillSeed || 'random'},麻将 27 牌型)`);
            const board = new Board(level);
            pile.setup(board, level.elements);
            this.runAgentDebug(pile, board, elements);
            return;
        }

        const cfg = { ...CFG, torqueMode: this.useStrictTorque ? 'strict' as const : 'razor' as const };
        const result = generateLayout(cfg);
        log(`[LayoutPreview] 力矩=${cfg.torqueMode} 层量=${result.stats.layerCounts} `
            + `开局可点=${result.stats.openTiles} maxDepth=${result.stats.maxDepth}`);

        const fillElements = buildMahjongElements();
        const level: LevelData = {
            board: CFG.board,
            elements: fillElements,
            tiles: fillSlots(result.slots, { elements: fillElements, seed: this.fillSeed || undefined }),
        };
        const board = new Board(level);
        pile.setup(board, level.elements);
        this.runAgentDebug(pile, board, fillElements);
        } catch (e) {
            console.error('[LayoutPreview] 初始化异常', e);
            throw e;   // 调试期向上抛,便于浏览器控制台直接观察
        }
    }

    /** 挂接仿真玩家代理 debug 可视化(选中交互为主;elements 用于中文名显示) */
    private runAgentDebug(pile: PileView, board: Board, elements: ElementDef[]): void {
        if (!this.agentDebug) return;
        attachAgentDebug(pile, board, {
            showStatic: this.agentShowStatic,
            elements,
        });
    }
}
