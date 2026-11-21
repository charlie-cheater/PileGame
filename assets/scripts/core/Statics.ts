// ============================================================================
// Statics.ts — 力矩平衡判定(2D 投影刚体静力学,纯几何)
//
// 判据:重心落在支撑凸包(各接触矩形角点的凸包)内 ⇔ 合力矩可平衡。
// 刀刃规则(2026-11-19 设计确认,margin = 0):
//   · 重心严格在凸包内部 → 平衡,无附加条件
//   · 重心恰在凸包边界(半张格点下的必然情形,距离 = 0)→ 刀刃平衡,
//     仅当 接触面积比 > razorAreaRatio(默认 0.25,严格大于)放行
//     —— 半张悬臂(0.5)合法,斜向四分之一(0.25)拒绝
//   · 重心在凸包外 → 不平衡
//
// 半张格点定理(背景):位置步长为 0.5×牌面时,单支点偏移的重心到凸包
// 边界距离恒为 0,任何正 margin 都会拒绝它们;刀刃+面积门槛即为对此的
// 设计应答。整数坐标下点/边判定用叉积精确计算,无浮点误差。
// ============================================================================

import { Unit, TILE } from './tile';

export interface ContactRect { x: Unit; y: Unit; w: Unit; h: Unit; }
interface Pt { x: number; y: number; }

export type BalanceVerdict = 'inside' | 'razor' | 'outside' | 'none';

/** 力矩策略:razor = 刀刃放行(面积门槛);strict = 禁止刀刃(重心须严格在凸包内) */
export type TorqueStrategy = 'razor' | 'strict';

export interface BalanceResult {
  ok: boolean;
  verdict: BalanceVerdict;
  /** 接触总面积 / 顶面面积 */
  contactAreaRatio: number;
}

/** 两轴对齐矩形交集(无交返回 null) */
export function rectIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): ContactRect | null {
  const x = Math.max(ax, bx);
  const y = Math.max(ay, by);
  const w = Math.min(ax + aw, bx + bw) - x;
  const h = Math.min(ay + ah, by + bh) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** 点集凸包(Andrew 单调链,逆时针) */
export function convexHull(points: ReadonlyArray<Pt>): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 点相对凸包(逆时针)的位置:严格内 / 边界 / 外 */
function classify(p: Pt, hull: ReadonlyArray<Pt>): 'inside' | 'boundary' | 'outside' {
  let onEdge = false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c < 0) return 'outside';
    if (c === 0) onEdge = true;
  }
  return onEdge ? 'boundary' : 'inside';
}

/**
 * 力矩平衡判定。
 * @param comX/comY 重心(通常为顶面矩形中心)
 * @param contacts 各支撑接触矩形(与紧邻下层牌的顶面交集)
 * @param razorAreaRatio 刀刃放行的接触面积比阈值(严格大于才放行)
 * @param strategy 'razor'(默认)= 刀刃+面积门槛;'strict' = 禁止刀刃,
 *                 重心恰在凸包边界即拒绝(半张格点下即拒绝全部单支点偏移)
 */
export function checkTorque(
  comX: number,
  comY: number,
  contacts: ReadonlyArray<ContactRect>,
  razorAreaRatio = 0.25,
  strategy: TorqueStrategy = 'razor',
): BalanceResult {
  let area = 0;
  const corners: Pt[] = [];
  for (const c of contacts) {
    area += c.w * c.h;
    corners.push({ x: c.x, y: c.y }, { x: c.x + c.w, y: c.y },
                 { x: c.x, y: c.y + c.h }, { x: c.x + c.w, y: c.y + c.h });
  }
  const ratio = area / (TILE.w * TILE.h);
  if (contacts.length === 0) return { ok: false, verdict: 'none', contactAreaRatio: 0 };

  const hull = convexHull(corners);
  const where = classify({ x: comX, y: comY }, hull);
  if (where === 'outside') return { ok: false, verdict: 'outside', contactAreaRatio: ratio };
  if (where === 'inside') return { ok: true, verdict: 'inside', contactAreaRatio: ratio };
  if (strategy === 'strict') return { ok: false, verdict: 'razor', contactAreaRatio: ratio };
  return { ok: ratio > razorAreaRatio, verdict: 'razor', contactAreaRatio: ratio };
}
