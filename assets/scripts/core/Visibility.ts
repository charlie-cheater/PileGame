// ============================================================================
// Visibility.ts — 当前可见牌状态(版面"最外层"暴露数据,2026-11-20 设计确认)
//
// 定义:牌 t 的顶面处于 t.layer 的 z 高度;所有 z 更高的 pile 牌的视觉体投影
// (顶面∪侧面,即 totalRect)与 face(t) 的交集构成 t 的覆盖并集。
//   exposedArea(t) = area(face(t)) − area(覆盖并集)
//   "至少有部分正面暴露在最外层" ⇔ exposedArea > 0(整数几何,精确无浮点)
//
// 与遮挡阈值判定(blacked,∃ 单一遮挡者 > 18%)正交:
//   · blocked 且部分暴露(20% 被盖 → 80% 暴露)✅ 常见
//   · 多个小面积遮挡累加盖满(每个 ≤18%,不 blocked)但 exposedArea=0 ✅ 可能
// 覆盖并集用坐标压缩网格精确求面积(整数坐标,格胞中点采样无歧义)。
// ============================================================================

import { Tile, TILE, UnitRect } from './tile';
import { faceRectOf, totalRectOf } from './Occlusion';

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

/** 轴对齐矩形集合的精确并集面积(坐标压缩 + 格胞中点采样;整数坐标无边界歧义) */
export function unionArea(rects: ReadonlyArray<UnitRect>): number {
  if (rects.length === 0) return 0;
  const xs = Array.from(new Set(rects.flatMap(r => [r.x, r.x + r.w]))).sort((a, b) => a - b);
  const ys = Array.from(new Set(rects.flatMap(r => [r.y, r.y + r.h]))).sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      for (const r of rects) {
        if (cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h) {
          area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
          break;
        }
      }
    }
  }
  return area;
}

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
      // 仅严格更高层覆盖计入(v2.1/v2.2:同层侧边渗入由绘制顺序消化,
      // 2026-11-20 修复:原先 isAbove 含同层 tileId 序,误将同层侧边计入暴露扣减)
      if (u.tileId === t.tileId || u.layer <= t.layer) continue;
      const tot = totalRectOf(u);
      const ix = Math.max(face.x, tot.x);
      const iy = Math.max(face.y, tot.y);
      const iw = Math.min(face.x + face.w, tot.x + tot.w) - ix;
      const ih = Math.min(face.y + face.h, tot.y + tot.h) - iy;
      if (iw > 0 && ih > 0) covers.push({ x: ix, y: iy, w: iw, h: ih });
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
