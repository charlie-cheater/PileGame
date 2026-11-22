// ============================================================================
// Perception.ts — 仿真玩家代理 · ①感知(纯逻辑,零节点依赖)
//
// 感知边界(2026-11-22 设计定稿):
//   · 感知集 = 有可见像素的 pile 牌(exposedArea > 0)+ 槽内牌(全可见)
//   · 身份通道:exposedRatio ≥ identifyThreshold(当前 0.25)才识别;未识别
//     牌拷贝时遮蔽 elementId → UNKNOWN_ELEMENT(单阈值,⏳ 两段式 B' 待设计)
//   · 几何字段(gx/gy/layer)随拷贝保留——仅作排序载体,深度由分析阶段重建
//   · 隐藏牌(exposedArea = 0)对代理不存在:不进感知集
//
// v3 等价定理(2026-11-22):感知子集上重算的覆盖并集 = 真实并集
// (任一被盖像素的最上层绘制者必为可见牌)⇒ 分析阶段的主观 clickable
// 精确等于真值;代理的不确定性只残留在 身份 与 隐藏节点的存在/揭示。
// ============================================================================

import { Board } from '../core/Board';
import { Tile, ElementId } from '../core/tile';

/** 身份未识别牌的 elementId 哨兵 */
export const UNKNOWN_ELEMENT: ElementId = '?';

export interface TileExposure {
  tileId: number;
  /** 暴露比例(0~1,像素真值) */
  exposedRatio: number;
  /** 完全暴露(无任何覆盖) */
  fullyExposed: boolean;
  /** 身份已识别(暴露比例达到识别阈值) */
  identityKnown: boolean;
}

/** 主观视图:①感知的输出,②分析的全部输入 */
export interface SubjectiveView {
  /** 感知到的 pile 牌(拷贝;未识别者 elementId 已遮蔽;status 归一为 'pile') */
  perceived: ReadonlyArray<Tile>;
  /** 槽内牌(拷贝,全可见,不遮蔽) */
  slot: ReadonlyArray<Tile>;
  /** 感知/识别状态(perceived 每张;暴露数据来自像素真值) */
  exposure: Map<number, TileExposure>;
  /** 感知时刻 pile 总数(轮廓统计;隐藏牌数量可知,位置不可知) */
  totalPileCount: number;
}

export interface PerceptionOptions {
  /** 识别阈值:exposedRatio ≥ 此值判为认出印花(当前 0.25,⏳ 两段式待定) */
  identifyThreshold?: number;
}

/** ①感知:Board(全知)→ 主观视图(受限) */
export function perceive(board: Board, opts: PerceptionOptions = {}): SubjectiveView {
  const threshold = opts.identifyThreshold ?? 0.25;
  const real = board.getVisibleState();

  const perceived: Tile[] = [];
  const exposure = new Map<number, TileExposure>();
  for (const t of board.allTiles()) {
    if (t.status !== 'pile') continue;
    const vis = real.byTile.get(t.tileId);
    if (!vis || vis.exposedArea <= 0) continue;          // 无可见像素 → 不感知

    const identityKnown = vis.exposedRatio >= threshold;
    perceived.push({
      ...t,
      status: 'pile',
      slotIndex: null,
      elementId: identityKnown ? t.elementId : UNKNOWN_ELEMENT,
    });
    exposure.set(t.tileId, {
      tileId: t.tileId,
      exposedRatio: vis.exposedRatio,
      fullyExposed: vis.fullyExposed,
      identityKnown,
    });
  }

  return {
    perceived,
    slot: board.slotTiles().map(t => ({ ...t })),
    exposure,
    totalPileCount: board.pileCount(),
  };
}
