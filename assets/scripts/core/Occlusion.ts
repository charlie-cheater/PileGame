// ============================================================================
// Occlusion.ts — 遮挡判定(v3 并集口径,纯逻辑实现)
//
// 口径沿革:
//   v2.x(2026-11-18~19):blocked ⇔ ∃ 单一遮挡者覆盖 > 阈值(不求和)
//   v3(2026-11-22 设计确认):多张牌遮挡同一张牌时计算**总遮挡**——
//     blocked ⇔ 覆盖并集(全部更高牌的投影∩本牌顶面,矩形并集精确求积,
//     不计交叠双计)/ 顶面面积 > TILE.overlapThreshold
//     或 跨层侧边擦及顶面任意面积(侧边免阈条款,v2.2 保留:边缘擦碰是
//     真实的上沿遮挡,与面积求和哲学正交)
//   可见面积(Visibility)同为并集口径,两模块共用 unionArea/coverRectOf。
//   v3 消除了 v2.x 的口径缝隙("多张小遮挡拼满 → 不 blocked 但完全不可见")。
//
// 成对谓词(v3 起按用途拆分,禁止混用):
//   · coversAny(o,t)  —— o 对 t 有任意正面积覆盖贡献(z 更高,含同层
//     subZ 前后)。遮挡 DAG 的边:Depth / OcclusionTopology / 暴露扣减用。
//   · pressesOn(o,t)  —— v2.2 级"实质压迫"(面对面 > 阈值,或跨层侧边
//     擦及)。物理支撑语义:LayoutGen 支撑判定用,不随 blocked 口径变化。
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

/** 轴对齐矩形交集(无交返回 null) */
function intersectRect(a: UnitRect, b: UnitRect): UnitRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** 轴对齐矩形集合的精确并集面积(坐标压缩 + 格胞中点采样;整数坐标无边界歧义)。
 *  blocked(v3 并集)与 Visibility(暴露扣减)共用。 */
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

// ─────────────────────────── 成对谓词(v3 按用途拆分) ───────────────────────────

/** 覆盖贡献矩形:遮挡者投在被遮挡者顶面上的区域;无贡献返回 null。
 *  仅 z 更高者可覆盖(同层 = subZ/tileId 前后序,前排盖后排);
 *  跨层取 totalRect(顶面∪侧面,含侧边),同层仅 faceRect(侧边渗入由
 *  绘制顺序消化,v2.1 口径保留)。占据模型布局同层恒无交(subZ 布局才有)。 */
export function coverRectOf(occluder: OcclusionSubject, target: OcclusionSubject): UnitRect | null {
  if (!isAbove(occluder, target)) return null;
  const face = faceRectOf(target);
  const occ = occluder.layer > target.layer ? totalRectOf(occluder) : faceRectOf(occluder);
  return intersectRect(occ, face);
}

/** 正贡献谓词:o 对 t 有任意正面积覆盖(遮挡 DAG 边)。
 *  Depth / OcclusionTopology 使用;并集口径下的保守骨架——移除全部
 *  贡献者后 t 必暴露(充分),个体未必必要(可能存在冗余贡献者)。 */
export function coversAny(occluder: OcclusionSubject, target: OcclusionSubject): boolean {
  return coverRectOf(occluder, target) !== null;
}

/** 实质压迫谓词(v2.2 原语义):面对面覆盖 > 阈值,或跨层侧边擦及。
 *  物理支撑语义(LayoutGen 支撑判定/C3):一张牌须真正"压在"另一张上,
 *  单对判定,不随 blocked 并集口径变化。 */
export function pressesOn(occluder: OcclusionSubject, target: OcclusionSubject): boolean {
  if (!isAbove(occluder, target)) return false;
  const face = faceRectOf(target);
  if (overlapArea(faceRectOf(occluder), face) / (TILE.w * TILE.h) > TILE.overlapThreshold) return true;
  return occluder.layer > target.layer && overlapArea(sideRectOf(occluder), face) > 0;
}

/** 单对覆盖面积(unit²;仅供信息/调试)。blocked 判定以 computeOcclusion
 *  的并集口径为准(v3),勿用本函数复写。 */
export function occlusionArea(occluder: OcclusionSubject, target: OcclusionSubject): number {
  return overlapArea(coverRectOf(occluder, target) ?? { x: 0, y: 0, w: 0, h: 0 }, faceRectOf(target));
}

// ─────────────────────────── 遮挡关系索引(v3 口径的结构部分) ───────────────────────────

/** 一条覆盖贡献:遮挡者 by 投在本牌顶面上的矩形 rect,及是否跨层侧边擦及 */
export interface CoverContribution {
  /** 遮挡者 tileId */
  by: number;
  /** 覆盖贡献矩形(= coverRectOf(遮挡者, 本牌)) */
  rect: UnitRect;
  /** 遮挡者跨层且其侧面擦及本牌顶面(侧边免阈条款) */
  sideTouch: boolean;
}

/** 遮挡关系索引:固定牌位下「谁压着谁」的全部结构信息,与被压判定的阈值部分相分离。
 *  同一盘面的多次「移除若干张后再判被压」(消除模拟、揭示预演)共用一份,
 *  不必每次全盘重算。 */
export interface OcclusionIndex {
  /** tileId → 全部覆盖贡献(所有 z 更高的 pile 牌) */
  coversOf: Map<number, CoverContribution[]>;
  /** tileId(遮挡者)→ 它直接压着的牌 */
  coveredBy: Map<number, number[]>;
  /** 全部牌的 tileId,升序(按它遍历即得升序的可点集) */
  order: number[];
}

/**
 * 收集遮挡关系(v3 口径的结构部分;computeOcclusion 的前半步)。
 * 对每张牌累计:全部 z 更高 pile 牌的覆盖贡献矩形,以及是否跨层侧边擦及。
 * 规则一字未改——与 2026-11-22 裁定的 v3 并集口径同源;2026-11-24 仅把
 * 「收集」与「逐牌求面积」拆开,供索引复用(消除模拟提速,方案甲)。
 */
function collectCovers(tiles: ReadonlyArray<Tile>): OcclusionIndex {
  const index: OcclusionIndex = { coversOf: new Map(), coveredBy: new Map(), order: [] };
  for (const t of tiles) {
    index.coversOf.set(t.tileId, []);
    index.coveredBy.set(t.tileId, []);
    index.order.push(t.tileId);
  }

  const accumulate = (o: OcclusionSubject, target: Tile): void => {
    const c = coverRectOf(o, target);
    if (!c) return;
    const sideTouch = o.layer > target.layer && overlapArea(sideRectOf(o), faceRectOf(target)) > 0;
    index.coversOf.get(target.tileId)!.push({ by: o.tileId, rect: c, sideTouch });
    index.coveredBy.get(o.tileId)!.push(target.tileId);
  };

  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const A = tiles[i];
      const B = tiles[j];
      if (A.status !== 'pile' || B.status !== 'pile') continue;
      accumulate(B, A);   // isAbove 已在 coverRectOf 内判
      accumulate(A, B);
    }
  }
  index.order.sort((a, b) => a - b);
  return index;
}

/** 剩余覆盖贡献下的被压判定(computeOcclusion 的后半步,对单张牌)。
 *  blocked ⇔ 剩余贡献里有跨层侧边擦及,或 剩余覆盖并集 / 顶面面积 > 阈值 */
function isBlockedBy(covers: ReadonlyArray<CoverContribution>, removed: ReadonlySet<number>): boolean {
  let sideTouch = false;
  const rects: UnitRect[] = [];
  for (const c of covers) {
    if (removed.has(c.by)) continue;
    rects.push(c.rect);
    if (c.sideTouch) sideTouch = true;
  }
  return sideTouch || unionArea(rects) / (TILE.w * TILE.h) > TILE.overlapThreshold;
}

/**
 * 为一组固定牌位的 pile 牌建立遮挡关系索引(全量,一次)。
 * 输入须全部为 status === 'pile' 的牌(感知集即满足)。
 * 配合 blockedAfter 使用:同一盘面下任意移除集的被压判定,不必全盘重算。
 */
export function buildOcclusionIndex(tiles: ReadonlyArray<Tile>): OcclusionIndex {
  for (const t of tiles) {
    if (t.status !== 'pile') throw new Error(`buildOcclusionIndex: 牌 ${t.tileId} 不在堆上(status=${t.status})`);
  }
  return collectCovers(tiles);
}

/**
 * 索引法被压判定:移除 removed 之后,一张仍未被移除的牌是否被压。
 * 与 computeOcclusion(原盘面 − removed) 对该牌的 blocked 严格等价
 * (同一份覆盖贡献、同一判定式;tests/occlusion-v3 有等价性回归)。
 * 调用方负责保证 target 自身不在 removed 里。
 */
export function blockedAfter(index: OcclusionIndex, target: number, removed: ReadonlySet<number>): boolean {
  return isBlockedBy(index.coversOf.get(target) ?? [], removed);
}

/** 由索引求全部牌的派生态(computeOcclusion 的后半步,全量;移除集为空)。
 *  已有索引时用它,不要再调 computeOcclusion 重复收集一遍 */
export function deriveOcclusion(index: OcclusionIndex, tiles: ReadonlyArray<Tile>): Map<number, TileDerived> {
  const none = new Set<number>();
  const result = new Map<number, TileDerived>();
  for (const t of tiles) {
    const blocked = t.status === 'pile' && isBlockedBy(index.coversOf.get(t.tileId)!, none);
    result.set(t.tileId, {
      blocked,
      clickable: t.status === 'pile' && !blocked,
      faceRect: faceRectOf(t),
      sideRect: sideRectOf(t),
      totalRect: totalRectOf(t),
    });
  }
  return result;
}

// ─────────────────────────── 全量重算 ───────────────────────────

/**
 * 计算全部牌的派生态(tileId → TileDerived)。
 * 每次牌堆变化(点击入槽 / 消除 / 撤回 / 洗牌)后调用;O(n²) 收集 + 并集求积,n ≤ ~150。
 *
 * blocked(v3 并集口径):
 *   覆盖并集 / 顶面面积 > TILE.overlapThreshold,或跨层侧边擦及(免阈条款);
 * 仅 status === 'pile' 的牌作为遮挡者参与;
 * clickable = status === 'pile' && !blocked。
 *
 * 2026-11-24 起内部拆为「收集遮挡关系」+「逐牌求面积」两步(规则不变):
 *   collectCovers → deriveOcclusion;输入全为 pile 牌且需要反复按移除集
 *   求被压时(消除模拟、揭示预演),改用 buildOcclusionIndex + deriveOcclusion +
 *   blockedAfter,收集只做一次。
 */
export function computeOcclusion(tiles: ReadonlyArray<Tile>): Map<number, TileDerived> {
  return deriveOcclusion(collectCovers(tiles), tiles);
}
