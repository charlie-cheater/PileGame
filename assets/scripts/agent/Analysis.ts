// ============================================================================
// Analysis.ts — 仿真玩家代理 · ②分析(纯逻辑):主观视图 → 结构认知
//
// 本文件实现分析阶段的第一批算子(2026-11-22 验收范围):
//   · 遮挡关系:感知子集内的成对上下边(coversAny 正贡献口径,v3)
//   · 遮挡深度:computeDepths(感知子集)——代理自建深度(真实深度的下界,
//     隐藏边未计入;感知边集单调增长,P1 投影)
//   · 揭露闭包:遮挡传递闭包大小(全部揭露需先移除的牌数,2026-11-23)
//   · 可点性:computeOcclusion(感知子集)——v3 等价定理下与真值一致
//   · 对账:主观 clickable vs 真实 clickable 的冲突清单(验收用,期望恒空)
//
// 效用/槽压/犹豫度等评估算子属后续批次,输入亦为本文件的产物。
// ============================================================================

import { TileDerived, UnitRect } from '../core/tile';
import { coversAny, computeOcclusion, coverRectOf, unionArea } from '../core/Occlusion';
import { computeDepths, DepthReport } from '../core/Depth';
import { buildOcclusionTopology } from '../core/OcclusionTopology';
import { SLOT_COUNT } from '../core/Board';
import { SubjectiveView, UNKNOWN_ELEMENT } from './Perception';

/** 感知子集内的一条遮挡边(above 覆盖 below) */
export interface OcclusionEdge {
  above: number;
  below: number;
  /** 跨层边(true)/ 同层 subZ 前后边(false) */
  crossLayer: boolean;
}

export interface AnalysisResult {
  /** 感知子集内的遮挡边集(DAG;真实遮挡 DAG 的可见子图) */
  edges: OcclusionEdge[];
  /** 每张感知牌的直接遮挡者 tileId 列表(谁压着我) */
  blockersOf: Map<number, number[]>;
  /** 每张感知牌直接遮挡的牌 tileId 列表(我压着谁;揭露效能 v1 的原料) */
  occludesOf: Map<number, number[]>;
  /** 代理自建深度报告(waves[0] = 主观立即可点波次) */
  depth: DepthReport;
  /** tileId → 遮挡传递闭包大小 = 全部揭露该牌需先移除的牌数
   *  (感知子集口径;复用 OcclusionTopology.allBlockers 单一事实源。
   *  2026-11-23 起作为匹配消耗的挖掘计量——闭包同时涵盖扇入宽度与
   *  链深,取代"最长链深度"代理:被 3 张浅牌同压 → 3,被单链深埋 3 层 → 3) */
  closureSize: Map<number, number>;
  /** 主观派生态:blocked / clickable / 逻辑矩形 */
  derived: Map<number, TileDerived>;
  /** 可点性对账:主观与真值不一致的 tileId(v3 定理下期望恒为空) */
  clickConflicts: number[];
}

/** ②分析:主观视图 → 结构认知(遮挡关系 / 深度 / 可点性) */
export function analyze(
  view: SubjectiveView,
  realDerived?: ReadonlyMap<number, TileDerived>,
): AnalysisResult {
  const tiles = view.perceived;

  const edges: OcclusionEdge[] = [];
  const blockersOf = new Map<number, number[]>(tiles.map(t => [t.tileId, [] as number[]]));
  const occludesOf = new Map<number, number[]>(tiles.map(t => [t.tileId, [] as number[]]));
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i];
      const b = tiles[j];
      if (coversAny(a, b)) {
        edges.push({ above: a.tileId, below: b.tileId, crossLayer: a.layer !== b.layer });
        blockersOf.get(b.tileId)!.push(a.tileId);
        occludesOf.get(a.tileId)!.push(b.tileId);
      } else if (coversAny(b, a)) {
        edges.push({ above: b.tileId, below: a.tileId, crossLayer: a.layer !== b.layer });
        blockersOf.get(a.tileId)!.push(b.tileId);
        occludesOf.get(b.tileId)!.push(a.tileId);
      }
    }
  }

  const depth = computeDepths(tiles);
  const derived = computeOcclusion(tiles);

  // 揭露闭包:传递闭包大小(OcclusionTopology 单一事实源;DAG 无环)
  const closureSize = new Map<number, number>();
  const topo = buildOcclusionTopology(tiles);
  topo.allBlockers.forEach((list, id) => closureSize.set(id, list.length));

  const clickConflicts: number[] = [];
  if (realDerived) {
    for (const t of tiles) {
      const mine = derived.get(t.tileId)?.clickable;
      const real = realDerived.get(t.tileId)?.clickable;
      if (mine !== undefined && real !== undefined && mine !== real) {
        clickConflicts.push(t.tileId);
      }
    }
  }

  return { edges, blockersOf, occludesOf, depth, closureSize, derived, clickConflicts };
}

// ─────────────────────────── 分析扩展:揭露效能 ───────────────────────────

/** 揭露效能(独占遮挡口径) */
export interface RevealUtility {
  /** tileId → 它直接遮挡的牌(独占覆盖:至少一像素仅由它覆盖) */
  direct: Map<number, number[]>;
  /** tileId → 直接遮挡数量(感知子集口径,真实值的下界) */
  count: Map<number, number>;
  /** 全场最大值(0 = 无任何独占遮挡) */
  max: number;
}

/**
 * 揭露效能 v1.5(2026-11-22 修订):独占遮挡数。
 *
 * 直接遮挡 ⇔ 遮挡者 o 对 t 顶面的覆盖中,存在**仅由 o 覆盖的像素**
 * (并集面积严格大于去掉 o 之后的并集)——即"移除 o 立即暴露新像素"。
 * 2026-11-22 初版(投影相交即计数)的缺陷:顶层牌投影一路探到 L1/L0,
 * 真实计数虚高至 10,而移除后那些像素仍被中间层盖着(冗余覆盖)——
 * 骑缝直接压着的 4 张才是真实揭落对象,独占口径与移除语义精确对应。
 *
 * 理论:不考虑其他因素时,独占遮挡数越多,移除这张牌的揭露收益越大。
 * 迭代方向:按被遮挡者加权(暴露比/深度/可点性)、定向揭落加成
 * (被遮挡者恰为槽内牌的伴)、独占面积代替张数。
 * 口径注意:遮挡者集合取感知子集——隐藏遮挡者的冗余关系代理不可知,
 * 计数为真实直接遮挡数的下界。
 */
export function revealUtility(view: SubjectiveView, analysis: AnalysisResult): RevealUtility {
  const byId = new Map(view.perceived.map(t => [t.tileId, t]));

  // 按被遮挡者聚合 coverRect
  const coversOf = new Map<number, Array<{ above: number; rect: UnitRect }>>();
  for (const e of analysis.edges) {
    const a = byId.get(e.above);
    const b = byId.get(e.below);
    if (!a || !b) continue;
    const rect = coverRectOf(a, b);
    if (!rect) continue;
    let arr = coversOf.get(b.tileId);
    if (!arr) { arr = []; coversOf.set(b.tileId, arr); }
    arr.push({ above: a.tileId, rect });
  }

  // 独占判定:全并集 > 去掉该遮挡者后的并集 ⇔ 存在仅由它覆盖的像素
  const direct = new Map<number, number[]>(view.perceived.map(t => [t.tileId, [] as number[]]));
  coversOf.forEach((covers, belowId) => {
    const areaAll = unionArea(covers.map(c => c.rect));
    for (let i = 0; i < covers.length; i++) {
      const others = covers.filter((_, j) => j !== i).map(c => c.rect);
      if (areaAll > unionArea(others)) {
        direct.get(covers[i].above)!.push(belowId);
      }
    }
  });

  const count = new Map<number, number>();
  let max = 0;
  direct.forEach((targets, id) => {
    count.set(id, targets.length);
    if (targets.length > max) max = targets.length;
  });
  return { direct, count, max };
}

// ─────────────────────────── 分析扩展:同类归组 ───────────────────────────

/** 已识别同型牌的单条记录(找伴素材) */
export interface IdentifiedTileRecord {
  tileId: number;
  /** 代理自建深度(感知子集口径) */
  depth: number;
  clickable: boolean;
}

/** 同一元素类型的已识别牌分组 */
export interface ElementGroup {
  elementId: string;
  /** 在堆中且身份已识别(含被压不可点;未识别的 '?' 牌不参与归组) */
  pile: IdentifiedTileRecord[];
  /** 槽内同型牌 tileId(入槽即识别,身份恒可知) */
  slot: number[];
}

export interface GroupReport {
  /** elementId → 分组(仅含当前视图中已识别的类型) */
  groups: Map<string, ElementGroup>;
  /** 已识别的 pile 牌总数 */
  identifiedPileCount: number;
  /** 感知在但身份未识别的 pile 牌数 */
  unknownPileCount: number;
}

/**
 * 同类归组:找出当前全部可识别的牌,按元素类型记录。
 * 范围 = 当前主观视图(pile 已识别 + 槽内全知);不含历史已消除牌
 * (剩余张数推算属内部状态/记忆模型,后续扩展点)。
 */
export function groupByIdentity(view: SubjectiveView, analysis: AnalysisResult): GroupReport {
  const groups = new Map<string, ElementGroup>();
  const ensure = (id: string): ElementGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { elementId: id, pile: [], slot: [] };
      groups.set(id, g);
    }
    return g;
  };

  let unknown = 0;
  for (const t of view.perceived) {
    if (t.elementId === UNKNOWN_ELEMENT) { unknown++; continue; }
    ensure(t.elementId).pile.push({
      tileId: t.tileId,
      depth: analysis.depth.depth.get(t.tileId) ?? 0,
      clickable: analysis.derived.get(t.tileId)?.clickable === true,
    });
  }
  for (const s of view.slot) ensure(s.elementId).slot.push(s.tileId);

  return {
    groups,
    identifiedPileCount: view.perceived.length - unknown,
    unknownPileCount: unknown,
  };
}


// ─────────────────────────── 分析扩展:匹配消耗(启动牌 × 目标牌) ───────────────────────────

/** 配对候选牌(槽内或已识别 pile 牌)的获取成本刻画 */
export interface MatchTileRef {
  tileId: number;
  /** 获取成本(空槽单位):槽内 = 0;pile = 1 + (revealDepth + revealCount) / 2。
   *  2026-11-23 v2.2:双口径平均——闭包口径偏保守(全揭露的下界加和)、
   *  深度口径偏乐观(仅最长链),取均对冲;两原始值并留对照 */
  acquireCost: number;
  /** 揭露消耗·闭包口径 = 遮挡传递闭包大小(全部揭露需先移除的牌数;
   *  涵盖扇入宽度与链深) */
  revealCount: number;
  /** 揭露消耗·深度口径 = 最长遮挡链深度(轮次语义;v1 原口径,保留对照) */
  revealDepth: number;
  /** 是否已在槽中(成本 0 的启动牌) */
  inSlot: boolean;
}

/** 匹配类型(描述性分类,由两张牌的成本形态导出) */
export type MatchType = 'close' | 'double' | 'hold' | 'dig';

export interface MatchOpportunity {
  elementId: string;
  /** 启动牌:配对两张中获取成本最低者(槽内牌成本 0,存在即恒为启动牌) */
  launcher: MatchTileRef;
  /** 目标牌:另一张(次低成本) */
  target: MatchTileRef;
  /** 匹配总消耗 = 启动牌 + 目标牌获取成本(空槽单位)。无论当前资源是否足够均计算 */
  matchCost: number;
  type: MatchType;
  /** 当前空槽能否立即启动(规则判定,见实现;资源不足仅冻结执行,不影响 matchCost) */
  executable: boolean;
}

export interface MatchReport {
  /** 按匹配消耗升序(同成本按 elementId) */
  opportunities: MatchOpportunity[];
  /** 当前空槽数 */
  emptySlots: number;
  /** 各类型机会计数 */
  byType: { close: number; double: number; hold: number; dig: number };
}

/**
 * 匹配消耗枚举(2026-11-23 v2,设计者口径;同日 v2.1 挖掘计量升级):
 *   · 每元素取获取成本最低的两张已识别候选牌(含槽内)组成最优配对
 *   · 启动牌 = 成本最低那张;槽内牌 = 成本 0 的启动牌
 *   · matchCost = 两张获取成本之和——即便当前空槽不允许执行也计算
 *     (如双埋型:成本 = 揭露两张牌的全部资源消耗估计)
 *   · 获取成本:槽内 0 / 可点 1 / 被压 1 + (闭包口径 + 深度口径) / 2
 *     (v2.2 双口径平均——闭包偏保守、深度偏乐观;两原始值并留对照)
 *
 * 迭代方向:遮挡者自身配对成本的递归、并发持有的峰值口径(现为加和估计)。
 * 下界语义:未识别/隐藏的更便宜伴不在候选内,列表与成本均为真实最优的下界。
 */
export function matchOpportunities(view: SubjectiveView, analysis: AnalysisResult): MatchReport {
  const groups = groupByIdentity(view, analysis);
  const emptySlots = SLOT_COUNT - view.slot.length;
  const closureOf = (id: number): number => analysis.closureSize.get(id) ?? 0;
  const depthOf = (id: number): number => analysis.depth.depth.get(id) ?? 0;
  const clickableOf = (id: number): boolean =>
    analysis.derived.get(id)?.clickable === true;

  const opportunities: MatchOpportunity[] = [];

  groups.groups.forEach(g => {
    // 候选:槽内(至多 1 张,成本 0)+ 已识别 pile 牌(成本 1 + 双口径均值)
    const candidates: MatchTileRef[] = [];
    if (g.slot.length > 0) {
      candidates.push({ tileId: g.slot[0], acquireCost: 0, revealCount: 0, revealDepth: 0, inSlot: true });
    }
    for (const r of g.pile) {
      const blocked = !clickableOf(r.tileId);
      const cnt = blocked ? closureOf(r.tileId) : 0;
      const dep = blocked ? depthOf(r.tileId) : 0;
      candidates.push({
        tileId: r.tileId,
        acquireCost: 1 + (cnt + dep) / 2,
        revealCount: cnt,
        revealDepth: dep,
        inSlot: false,
      });
    }
    if (candidates.length < 2) return;   // 伴不可见/单张:当前信息下不成对

    candidates.sort((a, b) => a.acquireCost - b.acquireCost || a.tileId - b.tileId);
    const launcher = candidates[0];
    const target = candidates[1];
    const matchCost = launcher.acquireCost + target.acquireCost;

    const type: MatchType =
      launcher.inSlot && target.revealCount === 0 ? 'close'
      : !launcher.inSlot && launcher.revealCount === 0 && target.revealCount === 0 ? 'double'
      : launcher.revealCount > 0 ? 'dig'
      : 'hold';

    // 启动合法性(v1 规则口径):非闭对拾取入槽后须 ≤3 → 需 2 空槽;
    // 闭对 1;启动牌已在槽(持有中):目标可点 1、目标被压按下界 2
    const executable = launcher.inSlot
      ? (target.revealCount === 0 ? emptySlots >= 1 : emptySlots >= 2)
      : emptySlots >= 2;

    opportunities.push({ elementId: g.elementId, launcher, target, matchCost, type, executable });
  });

  opportunities.sort((a, b) =>
    a.matchCost - b.matchCost || (a.elementId < b.elementId ? -1 : 1));

  const byType = { close: 0, double: 0, hold: 0, dig: 0 };
  opportunities.forEach(o => { byType[o.type]++; });

  return { opportunities, emptySlots, byType };
}
