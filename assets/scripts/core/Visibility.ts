// ============================================================================
// Visibility.ts — 当前可见牌状态(版面"最外层"暴露数据,2026-11-20 设计确认)
//
// 定义:牌 t 的顶面处于 t.layer 的 z 高度;所有 z 更高 pile 牌的覆盖贡献
// (跨层 = 顶面∪侧面 totalRect;同层 = 顶面 faceRect,subZ 布局的 前排盖后排;
// 2026-11-22 v3 统一口径,与 Occlusion.coverRectOf 单一事实源)与 face(t)
// 的交集构成 t 的覆盖并集。
//   exposedArea(t) = area(face(t)) − area(覆盖并集)
//   "至少有部分正面暴露在最外层" ⇔ exposedArea > 0(整数几何,精确无浮点)
//
// 与 blocked 判定(v3 起同为并集口径)的关系:blocked = 覆盖并集 > 18%
// 或跨层侧边擦及。二者仍非同义:部分被盖(≤阈值)可以 blocked=false 而
// exposedArea 介于 0~100%;完全被盖(exposedArea=0)在 v3 下必 blocked
// (并集 ≥ 100% > 阈值,v2.x 的"不可见但可点"缝隙已消除)。
// 覆盖并集用坐标压缩网格精确求面积(整数坐标,格胞中点采样无歧义)。
// ============================================================================

import { Tile, TILE, UnitRect } from './tile';
import { faceRectOf, coverRectOf, unionArea } from './Occlusion';

const TILE_AREA = TILE.w * TILE.h;

export interface TileVisibility {
  tileId: number;
  /** 顶面暴露面积(unit²)= faceArea − 覆盖并集面积 */
  exposedArea: number;
  /** 暴露比例 exposedArea / faceArea(0~1) */
  exposedRatio: number;
  /** 完全暴露(无任何覆盖) */
  fullyExposed: boolean;
  /** 完全被覆盖( exposedArea = 0,即使按阈值判定可能仍 clickable) */
  fullyCovered: boolean;
}

export interface VisibleState {
  /** 全部 pile 牌的可见性数据(含 fullyCovered;slot/eliminated 不含) */
  byTile: Map<number, TileVisibility>;
  /** 至少有部分正面暴露在"最外层"的所有 tileId(按暴露面积降序) */
  exposedIds: number[];
  /** 版面总暴露面积(unit² 汇总) */
  totalExposedArea: number;
}

/** 轴对齐矩形集合的精确并集面积(坐标压缩;实现迁至 Occlusion.unionArea) */

/** 计算当前版面可见状态;仅 status='pile' 的牌参与(作为主体与遮挡者) */
export function computeVisibleState(tiles: ReadonlyArray<Tile>): VisibleState {
  const pile = tiles.filter(t => t.status === 'pile');
  const faceArea = TILE_AREA;
  const byTile = new Map<number, TileVisibility>();
  const exposedIds: number[] = [];
  let totalExposedArea = 0;

  for (const t of pile) {
    const face = faceRectOf(t);
    const covers: UnitRect[] = [];
    for (const u of pile) {
      if (u.tileId === t.tileId) continue;
      // v3 统一口径:coverRectOf 内部判 z 序——跨层 totalRect(含侧边),
      // 同层仅 faceRect(subZ 前排);同层侧边渗入仍不计(绘制序消化)
      const c = coverRectOf(u, t);
      if (c) covers.push(c);
    }
    const exposedArea = Math.max(0, faceArea - unionArea(covers));
    const exposedRatio = exposedArea / faceArea;
    byTile.set(t.tileId, {
      tileId: t.tileId,
      exposedArea,
      exposedRatio,
      fullyExposed: exposedRatio >= 0.999,
      fullyCovered: exposedRatio <= 0.001,
    });
    if (exposedArea > 0) {
      exposedIds.push(t.tileId);
      totalExposedArea += exposedArea;
    }
  }
  exposedIds.sort((a, b) =>
    (byTile.get(b)!.exposedArea - byTile.get(a)!.exposedArea) || (a - b));

  return { byTile, exposedIds, totalExposedArea };
}
