// ============================================================================
// Occlusion.ts — 遮挡判定(非对称口径 v2)纯逻辑实现
//
// 口径(见 tile.ts 文件头,v2.1):
//   遮挡者贡献 = 跨层时 totalRect(顶面 ∪ 侧面);同层时仅 faceRect;
//   被遮挡者受保护面 = faceRect(顶面/信息面);
//   blocked ⇔ 存在单一遮挡者 t',overlapArea / area(faceRect(t)) > TILE.overlapThreshold
//             (∃ 语义,不做多遮挡者求和)
//   同层侧边渗入不算遮挡:侧面是"厚度",只遮挡真正被压在下面的跨层牌;
//   同层相邻牌的侧边视觉重叠由绘制顺序(层内从后往前)消化,与遮挡无关。
//   规则⑥:覆盖仅落在自身侧面的面积不构成有效遮挡——统一 TILE 尺寸下
//          "盖到侧面而不盖顶面"几何不可达,作为安全性条款保留。
//
// z 序:三键字典序 (layer, subZ ?? 0, tileId);
//      第三键兑现 tile.ts "未显式 subZ 时以关卡数组序兜底" 的约定。
// ============================================================================

import { Tile, TileDerived, UnitRect, Unit, TILE } from './tile';

// ─────────────────────────── 遮挡主体与公共谓词 ───────────────────────────

/** 遮挡判定主体:Tile 与位置骨架(深度计算等)共用的最小结构(单一事实源) */
export interface OcclusionSubject {
  tileId: number;
  gx: Unit;
  gy: Unit;
  layer: number;
  subZ?: number;
}

// ─────────────────────────── z 序 ───────────────────────────

/** z 序比较键:[layer, subZ(缺省 0), tileId(= 关卡数组序,兜底并列)] */
export type ZKey = readonly [number, number, number];

export function zKeyOf(t: OcclusionSubject): ZKey {
  return [t.layer, t.subZ ?? 0, t.tileId];
}

/** a 是否严格高于 b(z 字典序比较) */
export function isAbove(a: OcclusionSubject, b: OcclusionSubject): boolean {
  const ka = zKeyOf(a);
  const kb = zKeyOf(b);
  return ka[0] !== kb[0] ? ka[0] > kb[0]
       : ka[1] !== kb[1] ? ka[1] > kb[1]
       : ka[2] > kb[2];
}

// ─────────────────────────── 矩形派生 ───────────────────────────

/** 顶面矩形(信息面 = 点击命中区) */
export function faceRectOf(t: OcclusionSubject): UnitRect {
  return { x: t.gx, y: t.gy, w: TILE.w, h: TILE.h };
}

/** 侧面矩形(厚度足迹,顶面下缘向下 sideH;仅作为遮挡者参与) */
export function sideRectOf(t: OcclusionSubject): UnitRect {
  return { x: t.gx, y: t.gy - TILE.sideH, w: TILE.w, h: TILE.sideH };
}

/** 视觉体投影矩形 = 顶面 ∪ 侧面(同宽相接,恰为矩形) */
export function totalRectOf(t: OcclusionSubject): UnitRect {
  return { x: t.gx, y: t.gy - TILE.sideH, w: TILE.w, h: TILE.h + TILE.sideH };
}

// ─────────────────────────── 矩形交叠 ───────────────────────────

/** 轴对齐矩形交叠面积(unit²;不相交为 0) */
export function overlapArea(a: UnitRect, b: UnitRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 遮挡者对目标顶面的覆盖面积(unit²;不含方向/z 判定,同/跨层矩形选择在内)。
 *  仅供信息/调试;判定逻辑以 blocksOcclusion 为准(v2.2 谓词含侧边免阈分支)。 */
export function occlusionArea(occluder: OcclusionSubject, target: OcclusionSubject): number {
  const face = faceRectOf(target);
  const occ = occluder.layer > target.layer ? totalRectOf(occluder) : faceRectOf(occluder);
  return overlapArea(occ, face);
}

/** 完整遮挡谓词(口径 v2.2 单一事实源,2026-11-19 设计确认):
 *  · z 更高 且 面对面覆盖 > 阈值 → 挡
 *  · 跨层时:侧边擦及顶面任意面积(side∩face > 0)即挡 —— 侧边免阈
 *    (侧边条仅 sideH 高,任何可见擦边都是真实的上沿遮挡)
 *  · 同层时:侧边不计(任何面积;v2.1,渗入由绘制顺序消化——前排顶面盖后排侧边)
 *  Occlusion.computeOcclusion 与 Depth.computeDepths 共用,禁止另行复写。 */
export function blocksOcclusion(occluder: OcclusionSubject, target: OcclusionSubject): boolean {
  if (!isAbove(occluder, target)) return false;
  const face = faceRectOf(target);
  if (overlapArea(faceRectOf(occluder), face) / (TILE.w * TILE.h) > TILE.overlapThreshold) return true;
  return occluder.layer > target.layer && overlapArea(sideRectOf(occluder), face) > 0;
}

// ─────────────────────────── 全量重算 ───────────────────────────

/**
 * 计算全部牌的派生态(tileId → TileDerived)。
 * 每次牌堆变化(点击入槽 / 消除 / 撤回 / 洗牌)后调用;O(n²),n ≤ ~60。
 *
 * 仅 status === 'pile' 的牌作为遮挡者参与;
 * clickable = status === 'pile' && !blocked。
 */
export function computeOcclusion(tiles: ReadonlyArray<Tile>): Map<number, TileDerived> {
  const info = tiles.map(t => ({
    t,
    face: faceRectOf(t),
    total: totalRectOf(t),
    blocked: false,
  }));

  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const A = info[i];
      const B = info[j];
      if (A.t.status !== 'pile' || B.t.status !== 'pile') continue;

      // ∃ 语义:任一遮挡者满足 v2.2 谓词即挡
      if (isAbove(B.t, A.t) && blocksOcclusion(B.t, A.t)) A.blocked = true;
      if (isAbove(A.t, B.t) && blocksOcclusion(A.t, B.t)) B.blocked = true;
    }
  }

  const result = new Map<number, TileDerived>();
  for (const e of info) {
    result.set(e.t.tileId, {
      blocked: e.blocked,
      clickable: e.t.status === 'pile' && !e.blocked,
      faceRect: e.face,
      sideRect: sideRectOf(e.t),
      totalRect: e.total,
    });
  }
  return result;
}

// 注:若未来需要"多遮挡者并集覆盖"口径(两个各盖 12% → 视为 24% 被挡),
// 需按矩形并集精确计算(避免交叠双计),当前按定稿 ∃ 口径实现。
