// ============================================================================
// Analysis.ts — 仿真玩家代理 · ②分析(纯逻辑):主观视图 → 结构认知
//
// 本文件实现分析阶段的第一批算子(2026-11-22 验收范围):
//   · 遮挡关系:感知子集内的成对上下边(coversAny 正贡献口径,v3)
//   · 遮挡深度:computeDepths(感知子集)——代理自建深度(真实深度的下界,
//     隐藏边未计入;感知边集单调增长,P1 投影)
//   · 揭露闭包:遮挡传递闭包大小(全部揭露需先移除的牌数,2026-11-23)
//   · 可点性:computeOcclusion(感知子集)——v3 等价定理下与真值一致
//   · 对账(主观 clickable vs 真值)不进本结果,分析保持纯主观(2026-11-23 移除
//     AnalysisResult.clickConflicts):验收对账在 tests 侧,运行期校验在 Runner 驱动侧
//
// 效用/槽压/犹豫度等评估算子属后续批次,输入亦为本文件的产物。
// 2026-11-23:reveal/groups/mate/matches 全部内化为 analyze() 的产出
// (AnalysisResult 子属性),独立查询函数不再导出——②分析的对外入口收敛为 analyze。
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
  /** 揭露效能(独占遮挡口径;随分析产出,2026-11-23 起为子属性) */
  reveal: RevealUtility;
  /** 同类归组报告(随分析产出) */
  groups: GroupReport;
  /** 伴成本与伴去向报告(随分析产出) */
  mate: MateCostReport;
  /** 匹配机会报告(随分析产出) */
  matches: MatchReport;
}

/** ②分析:主观视图 → 结构认知 + 全部派生报告(揭露效能 / 同类归组 /
 *  伴成本去向 / 匹配机会,2026-11-23 起全部内化为子属性)。
 *  只接收主观视图,不接收任何真值(对账见 Runner / tests) */
export function analyze(view: SubjectiveView): AnalysisResult {
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

  // 组装:基础结构先行,派生报告依序产出(均消费 analysis 本体;
  // groups/mate/matches 各自内部会再调 groupByIdentity,当前规模下重算可接受)
  const analysis = { edges, blockersOf, occludesOf, depth, closureSize, derived } as AnalysisResult;
  analysis.reveal = revealUtility(view, edges);
  analysis.groups = groupByIdentity(view, analysis);
  analysis.mate = mateCosts(view, analysis);
  analysis.matches = matchOpportunities(view, analysis);
  return analysis;
}

// ─────────────────────────── 分析扩展:揭露效能 ───────────────────────────

/** 一对独占覆盖的面积记录(occluder above 对被遮挡者 below 的独占像素量) */
export interface ExclusiveCover {
  above: number;
  below: number;
  /** 独占面积(unit²,整数):全并集 − 去掉 above 后的并集
   *  = 移除 above 后 below 顶面立即新暴露的像素量 */
  area: number;
}

/** 揭露效能(独占遮挡口径;作为 AnalysisResult.reveal 随分析产出,2026-11-23) */
export interface RevealUtility {
  /** tileId → 独占遮挡数(感知子集口径,真实值的下界;全部感知牌入表,无为 0)。
   *  独占 = 至少一像素仅由它覆盖 = exclusivePairs 按 above 计数;
   *  与 occludesOf(全部投影遮挡)的差 = 冗余覆盖被剔除,二者非重复 */
  count: Map<number, number>;
  /** 全场最大值(0 = 无任何独占遮挡) */
  max: number;
  /** 独占覆盖 pair 清单(分布事实;「谁独占遮挡谁」按 above 分组即得,
   *  不再单列 direct 字段——2026-11-23 移除,消费端按需重建) */
  exclusivePairs: ExclusiveCover[];
  /** tileId → 独占面积合计(unit²;count 的面积版标量,张数王 ≠ 面积王可能) */
  area: Map<number, number>;
  /** 全场最大独占面积合计(0 = 无) */
  maxArea: number;
}

/**
 * 揭露效能 v1.6(2026-11-23):独占遮挡数 + 独占面积数据。
 *
 * 直接遮挡 ⇔ 遮挡者 o 对 t 顶面的覆盖中,存在**仅由 o 覆盖的像素**
 * (并集面积严格大于去掉 o 之后的并集)——即"移除 o 立即暴露新像素"。
 * 2026-11-22 初版(投影相交即计数)的缺陷:顶层牌投影一路探到 L1/L0,
 * 真实计数虚高至 10,而移除后那些像素仍被中间层盖着(冗余覆盖)——
 * 骑缝直接压着的 4 张才是真实揭落对象,独占口径与移除语义精确对应。
 * v1.6 起 pair 同时记录独占面积(= 上述并集差值,原被丢弃):
 * 张数把"一丝"与"半张"算成同一个 1,面积才是能改变状态转移的量
 * (过识别阈值 0.25 / 压回 blocked 阈值 18% 都以 unit² 计);分布按
 * pair 保留,聚合/加权方式留给③决策消费端选择。
 *
 * 理论:不考虑其他因素时,独占遮挡数越多,移除这张牌的揭露收益越大。
 * 迭代方向:按被遮挡者加权(暴露比/深度/可点性)、定向揭落加成
 * (被遮挡者恰为槽内牌的伴);张数→面积的标量替换属③决策消费侧选择
 * (数据 v1.6 已就位)。
 * 口径注意(主观,2026-11-23 用户指示):全部计算基于感知子集,不做全知——
 *   · pair 范围 = 遮挡者与被遮挡者均在感知集内(真实 pair 集的子集,计数为下界);
 *   · 单个 pair 的主观独占面积 ≥ 真值:被遮挡像素上若还压着未感知的隐藏牌,
 *     代理不可知,该像素仍计入可见遮挡者的独占(主观语义"我移走它就能看到
 *     下面"——真值上露出的可能是隐藏牌的顶面,即⑤预期阶段的惊讶来源)。
 *
 * 2026-11-23 起内化为 analyze 的产出步骤(随 AnalysisResult.reveal 返回),
 * 不再单独导出;direct 字段移除(exclusivePairs 按 above 分组即得)。
 */
function revealUtility(view: SubjectiveView, edges: ReadonlyArray<OcclusionEdge>): RevealUtility {
  const byId = new Map(view.perceived.map(t => [t.tileId, t]));

  // 按被遮挡者聚合 coverRect
  const coversOf = new Map<number, Array<{ above: number; rect: UnitRect }>>();
  for (const e of edges) {
    const a = byId.get(e.above);
    const b = byId.get(e.below);
    if (!a || !b) continue;
    const rect = coverRectOf(a, b);
    if (!rect) continue;
    let arr = coversOf.get(b.tileId);
    if (!arr) { arr = []; coversOf.set(b.tileId, arr); }
    arr.push({ above: a.tileId, rect });
  }

  // 独占判定:全并集 − 去掉该遮挡者后的并集 = 独占面积(> 0 即独占)
  const exclusivePairs: ExclusiveCover[] = [];
  coversOf.forEach((covers, belowId) => {
    const rects = covers.map(c => c.rect);
    const areaAll = unionArea(rects);
    for (let i = 0; i < covers.length; i++) {
      const others = rects.filter((_, j) => j !== i);
      const exclusive = areaAll - unionArea(others);
      if (exclusive > 0) {
        exclusivePairs.push({ above: covers[i].above, below: belowId, area: exclusive });
      }
    }
  });

  // 独占遮挡数:pair 按 above 计数(全部感知牌入表,无为 0)
  const count = new Map<number, number>(view.perceived.map(t => [t.tileId, 0]));
  let max = 0;
  for (const p of exclusivePairs) count.set(p.above, count.get(p.above)! + 1);
  count.forEach(n => { if (n > max) max = n; });

  // 独占面积合计(与 count 同形:全部感知牌入表,无为 0)
  const area = new Map<number, number>(view.perceived.map(t => [t.tileId, 0]));
  let maxArea = 0;
  for (const p of exclusivePairs) {
    area.set(p.above, (area.get(p.above) ?? 0) + p.area);
  }
  area.forEach(a => { if (a > maxArea) maxArea = a; });

  return { count, max, exclusivePairs, area, maxArea };
}

// ─────────────────────────── v2.2 获取成本(单一事实源) ───────────────────────────

/**
 * v2.2 获取成本(flat):可点 1 / 被压 1 + (闭包 + 深度)/2 双口径平均。
 * 全文件三处内联式(定价引擎 falloff、伴成本计价、匹配消耗计价)与
 * Ladder 梯内效能打分的共同口径源;改动须经设计确认。
 */
export function flatCostOf(tileId: number, analysis: AnalysisResult): number {
  if (analysis.derived.get(tileId)?.clickable === true) return 1;
  return 1 + ((analysis.closureSize.get(tileId) ?? 0) + (analysis.depth.depth.get(tileId) ?? 0)) / 2;
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
 * 2026-11-23 起内化为 analyze 的产出步骤(随 AnalysisResult.groups 返回),
 * 不再单独导出。
 */
function groupByIdentity(view: SubjectiveView, analysis: AnalysisResult): GroupReport {
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
  /** v2.3 递归获取成本(buildPricingEngine.acquireTop:仅闭包口径、
   *  递归深度 ≤3、回环切断回落 v2.2)。**另档留档,不覆盖 acquireCost**,
   *  两档对照供③决策消费(2026-11-23 用户指示);槽内 = 0 */
  acquireCostR: number;
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
  /** v2.3:launcher.acquireCostR + target.acquireCostR(另档,不覆盖 matchCost;
   *  列表排序仍按 v2.2 matchCost——行为不变,消费切换属③决策) */
  matchCostR: number;
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
 * 迭代方向:遮挡者自身配对成本的递归(**已实现为另档 acquireCostR/matchCostR,
 * 2026-11-23;v2.2 值保留对照**);并发持有的峰值口径(现为加和估计)后续再议。
 * 下界语义:未识别/隐藏的更便宜伴不在候选内,列表与成本均为真实最优的下界。
 *
 * 2026-11-23 起内化为 analyze 的产出步骤(随 AnalysisResult.matches 返回),
 * 不再单独导出。
 */
function matchOpportunities(view: SubjectiveView, analysis: AnalysisResult): MatchReport {
  const groups = groupByIdentity(view, analysis);
  const engine = buildPricingEngine(view, analysis);   // v2.3 另档定价(acquireCostR)
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
      candidates.push({ tileId: g.slot[0], acquireCost: 0, acquireCostR: 0,
                        revealCount: 0, revealDepth: 0, inSlot: true });
    }
    for (const r of g.pile) {
      const blocked = !clickableOf(r.tileId);
      const cnt = blocked ? closureOf(r.tileId) : 0;
      const dep = blocked ? depthOf(r.tileId) : 0;
      candidates.push({
        tileId: r.tileId,
        acquireCost: flatCostOf(r.tileId, analysis),
        acquireCostR: engine.acquireTop(r.tileId),
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
    const matchCostR = launcher.acquireCostR + target.acquireCostR;

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

    opportunities.push({ elementId: g.elementId, launcher, target, matchCost, matchCostR, type, executable });
  });

  opportunities.sort((a, b) =>
    a.matchCost - b.matchCost || (a.elementId < b.elementId ? -1 : 1));

  const byType = { close: 0, double: 0, hold: 0, dig: 0 };
  opportunities.forEach(o => { byType[o.type]++; });

  return { opportunities, emptySlots, byType };
}

// ─────────────────────────── 分析扩展:伴成本(v2.3 配对负担加权 · 分步第一步) ───────────────────────────

/** 递归拓扑事件:一次定价(v2.3 引擎)的记录(2026-11-23 用户指示:
 *  留作③决策阶段素材——依赖树可经 parent/blocker 重建,falloff 命中
 *  可作估计置信信号) */
export interface MatePriceEvent {
  /** 被定价的牌 */
  tileId: number;
  /** 递归层(顶层选伴 = 1;锚点 = 0) */
  depth: number;
  /** 定价结果(falloff 时为 v2.2 值) */
  value: number;
  /** 结局:normal 正常定价 / cycle 回环切断 / depth 深度截断 */
  outcome: 'normal' | 'cycle' | 'depth';
  /** 下钻通道:root 顶层选伴 / closure 闭包口径 unit(depthW 裁减后仅此两条) */
  channel: 'root' | 'closure';
  /** 定价父牌(承其估价帧下钻;锚点 = null) */
  parent: number | null;
  /** 经由的遮挡者(channel = closure 时:其配对需要本牌;root = null) */
  blocker: number | null;
}

/** 伴去向:闭包内某个遮挡者的伴,相对「本闭包」在哪(2026-11-23 重新建模——
 *  配对负担不折叠进成本,改为有界的结构分类;判据见 ClosureMateRecord) */
export type MateDisposition = 'ready' | 'contained' | 'external' | 'unknown';

/** 一条(被挖牌, 闭包成员)的伴去向记录 */
export interface ClosureMateRecord {
  /** 被挖牌(闭包的参照系;挖它须先移除 blocker) */
  target: number;
  /** 闭包成员(遮挡者) */
  blocker: number;
  /** 伴去向(优先级 ready > contained;unknown 与其余三类互斥):
   *  ready     伴在槽内或可点——顺手清掉,瞬态占槽即闭合
   *  contained 伴也埋在本闭包内(含伴即 target 本身)——配对在挖掘区内
   *            闭合,不开新战线(闭包内的双亮对属 ready)
   *  external  伴埋在闭包外——移除即分叉出第二战场(兔穴链)
   *  unknown   无已知伴('?' 或无候选)——不确定性(对接⑤预期) */
  disposition: MateDisposition;
  /** 选中的伴(= mateOf(blocker);unknown 为 null) */
  mateId: number | null;
  /** 伴的 v2.2 flat(= cost(blocker)):槽内 0 / 可点 1 / external 时即分叉战场深度 */
  mateFlat: number;
}

/** 四类计数(全部感知 pile 牌入表;闭包为空则全 0) */
export interface DispositionCount {
  ready: number;
  contained: number;
  external: number;
  unknown: number;
}

/** 伴成本报告:「以配对移除一张牌」时另一半的获取成本 + 伴去向分类
 *  (主观口径,单跳 flat 定价) */
export interface MateCostReport {
  /** tileId → 伴成本:
   *  0 = 最廉已知伴在槽内(配对半价已预付);
   *  flat(c) = 已识别 pile 伴中最廉者的 v2.2 获取成本;
   *  ambient = 无已知伴(元素未识别 '?' 或伴不在感知集)时的环境物价回落 */
  cost: Map<number, number>;
  /** tileId → 选中的伴 tileId(null = 无已知伴,走环境物价;并列取 tileId 小者) */
  mateOf: Map<number, number | null>;
  /** 环境物价 F:感知集内已识别 pile 牌的 flat(v2.2)均值(空集 = 1) */
  ambient: number;
  /** 闭包内遮挡者的伴去向记录:每 (target, blocker) 一条(闭包为空的 target 无记录);
   *  target 序 = perceived,blocker 升序(确定性) */
  closureMates: ClosureMateRecord[];
  /** target → 四类计数(之和 = analysis.closureSize)——有界聚合;
   *  外联率等比值由消费端按需派生,不在此预设 */
  dispositionCount: Map<number, DispositionCount>;
}

/**
 * 定价引擎工厂(模块内部;matchOpportunities 经 acquireCostR 另档消费)。
 *
 * **保留待评估(2026-11-23 用户裁定)**:递归定价分化过剧(闭包求和 +
 * 递归复利 + 重叠闭包重复计费,dig 均值 9 → 86)、不符人类直觉——
 * 不作为正式 mateCost 口径(已回退 v1 单跳);引擎存续于 acquireCostR
 * 另档,后续若找到利用价值再启用。
 *
 * 引擎口径(v2.3 原样保留):
 *   · acquireR(t) = 可点 1;被压 1 + closureW(仅闭包口径)
 *     closureW = Σ 闭包成员 unit(b);unit(b) = (1 + mateCost(b))/2
 *   · mateCost(b) = 槽内伴 0 / pile 已识别候选 acquireR(c, d+1) 最廉 / 无已知伴 → ambient
 *   · 递归深度硬上限 3(嵌套 acquireR 层数);抵达 → v2.2 flat falloff
 *   · 回环检测:估价栈上已在算的牌再现 → v2.2 flat;获取查询起点即被定价牌,
 *     acquireR 内部 stack.add 已覆盖重入(勿预置种子,否则首查恒 flat)
 *   · 事件流(traces):acquireTop 每次查询独立成流(完成序,子先于父,
 *     末条 = 起点根事件;暂由引擎内部持有,外显接口待需要时再加)
 *   · 主观口径与无记忆化等约定同前
 */
/** 闭包成员索引工厂(记忆化 DFS over blockersOf,与 OcclusionTopology.allBlockers
 *  同源即 closureSize 的成员版;tileId 升序确定性输出)。
 *  定价引擎与伴去向分类共用。 */
function makeClosureIndex(analysis: AnalysisResult): (id: number) => number[] {
  const memo = new Map<number, number[]>();
  return (id: number): number[] => {
    const hit = memo.get(id);
    if (hit) return hit;
    const set = new Set<number>();
    const walk = (x: number): void => {
      for (const b of analysis.blockersOf.get(x) ?? []) {
        if (!set.has(b)) { set.add(b); walk(b); }
      }
    };
    walk(id);
    const arr = [...set].sort((a, b) => a - b);
    memo.set(id, arr);
    return arr;
  };
}

interface PricingEngine {
  /** v2.3 递归获取成本(另档留档,不覆盖任何正式口径) */
  acquireTop(id: number): number;
  /** acquireTop 查询事件流(键 = 查询起点) */
  readonly traces: Map<number, MatePriceEvent[]>;
}

function buildPricingEngine(view: SubjectiveView, analysis: AnalysisResult): PricingEngine {
  /** 递归深度硬上限(嵌套 acquireR 层数;抵达回落 v2.2 flat) */
  const RECUR_LIMIT = 3;

  // flat:v2.2 获取成本(单一事实源 flatCostOf)——深断/环切的统一 falloff,
  // 亦是 ambient 的基础
  const flatOf = (id: number): number => flatCostOf(id, analysis);

  const groups = groupByIdentity(view, analysis);
  const byId = new Map(view.perceived.map(t => [t.tileId, t]));

  // 环境物价:已识别 pile 牌的 flat 均值(空集 = 1;槽内/未识别不计入)
  let ambient = 1;
  {
    const flats: number[] = [];
    groups.groups.forEach(g => g.pile.forEach(r => flats.push(flatOf(r.tileId))));
    if (flats.length > 0) ambient = flats.reduce((s, x) => s + x, 0) / flats.length;
  }

  // 每元素候选:槽内伴(至多记首张)+ 已识别 pile 候选(定价递归时算)
  const pileCandOf = new Map<string, number[]>();
  const slotMateOf = new Map<string, number>();
  groups.groups.forEach(g => {
    pileCandOf.set(g.elementId, g.pile.map(r => r.tileId));
    if (g.slot.length > 0) slotMateOf.set(g.elementId, g.slot[0]);
  });

  // 闭包成员表(与伴去向分类共用索引工厂 makeClosureIndex)
  const closureOf = makeClosureIndex(analysis);

  // 递归拓扑(事件在定价完成点记录;完成序,子先于父)
  const traces = new Map<number, MatePriceEvent[]>();
  let trace: MatePriceEvent[] | null = null;

  const acquireR = (id: number, depth: number, stack: Set<number>,
                    parent: number, channel: MatePriceEvent['channel'],
                    blocker: number | null): number => {
    const emit = (value: number, outcome: MatePriceEvent['outcome']): void => {
      if (trace) trace.push({ tileId: id, depth, value, outcome, channel, parent, blocker });
    };
    if (depth >= RECUR_LIMIT) {                       // 深断 → v2.2 flat falloff
      const v = flatOf(id);
      emit(v, 'depth');
      return v;
    }
    if (stack.has(id)) {                              // 回环切断 → v2.2 falloff
      const v = flatOf(id);
      emit(v, 'cycle');
      return v;
    }
    if (analysis.derived.get(id)?.clickable === true) {
      emit(1, 'normal');
      return 1;
    }

    stack.add(id);
    let closureW = 0;
    for (const b of closureOf(id)) {
      closureW += (1 + matePick(b, depth, stack, id, 'closure', b).cost) / 2;
    }
    stack.delete(id);
    const v = 1 + closureW;   // 仅闭包口径(2026-11-23 用户裁定:depthW 裁减)
    emit(v, 'normal');
    return v;
  };

  /** 选伴:槽内 0 / pile 候选递归定价最廉 / 无已知伴走环境物价 */
  const matePick = (b: number, depth: number, stack: Set<number>,
                    parent: number, channel: MatePriceEvent['channel'],
                    blocker: number | null):
      { cost: number; id: number | null } => {
    const el = byId.get(b)?.elementId;
    if (el !== undefined && el !== UNKNOWN_ELEMENT && slotMateOf.has(el)) {
      return { cost: 0, id: slotMateOf.get(el)! };
    }
    const list = el === undefined || el === UNKNOWN_ELEMENT ? undefined : pileCandOf.get(el);
    let best: { cost: number; id: number } | null = null;
    if (list) {
      for (const c of list) {
        if (c === b) continue;                        // 剔除自身
        const v = acquireR(c, depth + 1, stack, parent, channel, blocker);  // mate 边:+1 层
        if (!best || v < best.cost || (v === best.cost && c < best.id)) {
          best = { cost: v, id: c };
        }
      }
    }
    return best ?? { cost: ambient, id: null };
  };

  return {
    traces,
    acquireTop(id: number): number {
      trace = [];
      // 起点即被定价牌:内部 stack.add 覆盖重入,勿预置种子(否则恒 flat);
      // 末条根事件(tileId=id, channel='root', parent=null)即本查询结果
      const v = acquireR(id, 0, new Set(), null, 'root', null);
      traces.set(id, trace);
      return v;
    },
  };
}

/**
 * 伴成本枚举(v1 单跳口径,2026-11-23 用户裁定回退为正式口径):
 * 「以配对移除一张牌」时另一半的获取成本 = 已知候选的 **v2.2 flat** 最廉值,
 * 不经递归(递归版经实测分化过剧,不符人类直觉;引擎保留于
 * buildPricingEngine 供 acquireCostR 另档消费)。
 *
 * 口径(全部主观,不查真实 elementId、不看隐藏牌):
 *   · 候选集 = 同元素已识别 pile 牌 + 槽内同元素牌(groupByIdentity 单一
 *     事实源);'?' 牌无候选,走回落;最廉即可,并列取 tileId 小者
 *   · 伴成本:槽内 0 / pile flat(c) 最廉 / 无已知伴 → ambient
 *   · 回落 F(环境物价)= 已识别 pile 牌的 flat 均值——主观可算的
 *     「本盘牌普遍埋多深」,自适应盘面难度;无已识别牌时 = 1
 *   · 伴去向分类(配对数据的扩展):对每个有闭包的 target,其闭包成员 b 按伴的
 *     位置归类——伴在槽内/可点 = ready;否则伴 ∈ closure(target) ∪ {target}
 *     = contained(配对在挖掘区内闭合);否则 external(分叉出闭包外战场);
 *     无已知伴 = unknown。只记录不折价:成本口径(v2.2)不受影响
 *
 * 2026-11-23 起内化为 analyze 的产出步骤(随 AnalysisResult.mate 返回),
 * 不再单独导出。
 */
function mateCosts(view: SubjectiveView, analysis: AnalysisResult): MateCostReport {
  // flat:v2.2 获取成本(单一事实源 flatCostOf)
  const flatOf = (id: number): number => flatCostOf(id, analysis);

  const groups = groupByIdentity(view, analysis);

  // 环境物价:已识别 pile 牌的 flat 均值(空集 = 1;槽内/未识别不计入)
  let ambient = 1;
  {
    const flats: number[] = [];
    groups.groups.forEach(g => g.pile.forEach(r => flats.push(flatOf(r.tileId))));
    if (flats.length > 0) ambient = flats.reduce((s, x) => s + x, 0) / flats.length;
  }

  // 每元素候选价目:槽内 0 + 已识别 pile 各自 flat
  const priceOf = new Map<string, Array<{ tileId: number; cost: number }>>();
  groups.groups.forEach(g => {
    const list: Array<{ tileId: number; cost: number }> = [];
    g.slot.forEach(id => list.push({ tileId: id, cost: 0 }));
    g.pile.forEach(r => list.push({ tileId: r.tileId, cost: flatOf(r.tileId) }));
    priceOf.set(g.elementId, list);
  });

  const cost = new Map<number, number>();
  const mateOf = new Map<number, number | null>();
  for (const t of view.perceived) {
    const list = t.elementId === UNKNOWN_ELEMENT ? undefined : priceOf.get(t.elementId);
    let best: { tileId: number; cost: number } | null = null;
    if (list) {
      for (const c of list) {
        if (c.tileId === t.tileId) continue;          // 剔除自身
        if (!best || c.cost < best.cost
            || (c.cost === best.cost && c.tileId < best.tileId)) {
          best = c;
        }
      }
    }
    if (best) {
      cost.set(t.tileId, best.cost);
      mateOf.set(t.tileId, best.tileId);
    } else {
      cost.set(t.tileId, ambient);             // 无已知伴 / 未识别 → 环境物价
      mateOf.set(t.tileId, null);
    }
  }

  // ── 伴去向分类(闭包相对;只记录不折价)──
  const closureOf = makeClosureIndex(analysis);
  const slotIds = new Set(view.slot.map(s => s.tileId));
  const dispositionOf = (mateId: number | null, region: ReadonlySet<number>): MateDisposition => {
    if (mateId === null) return 'unknown';
    if (slotIds.has(mateId) || analysis.derived.get(mateId)?.clickable === true) return 'ready';
    return region.has(mateId) ? 'contained' : 'external';
  };

  const closureMates: ClosureMateRecord[] = [];
  const dispositionCount = new Map<number, DispositionCount>();
  for (const t of view.perceived) {
    const counts: DispositionCount = { ready: 0, contained: 0, external: 0, unknown: 0 };
    const members = closureOf(t.tileId);
    if (members.length > 0) {
      const region = new Set<number>(members);
      region.add(t.tileId);                    // 伴即 target 本身亦属挖掘区内闭合
      for (const b of members) {
        const mateId = mateOf.get(b) ?? null;
        const disposition = dispositionOf(mateId, region);
        counts[disposition]++;
        closureMates.push({ target: t.tileId, blocker: b, disposition, mateId, mateFlat: cost.get(b)! });
      }
    }
    dispositionCount.set(t.tileId, counts);
  }

  return { cost, mateOf, ambient, closureMates, dispositionCount };
}

// ─────────────────────────── 揭示预演(③决策的前向模型,主观) ───────────────────────────

/** 借槽两步闭合的分类(2026-11-23 用户裁定):揭出的这张牌下一步拿走即可闭对,
 *  区别只在「与谁闭」——与槽位容量无关的结构事实,可用性门槛由决策梯另判 */
export type ChainKind = 'slot' | 'pair';

/** 预演后变可点的直接目标(逐张记激活类型) */
export interface ForecastClickable {
  tileId: number;
  /** 激活类型(全部主观判据):
   *  closes —— 下一步拿它即闭对(值 1.0):该元素在槽内(chain = slot),
   *            或与本次拿的这张同元素——它入槽后即是伴(chain = pair)
   *  pairs  —— 该元素另有已识别牌,预演后亦可点 → 双亮对(值 0.8)
   *  lone   —— 可点但无已知可配的伴(值 0.2) */
  activation: 'closes' | 'pairs' | 'lone';
  /** 两步闭合的分类:slot = 与槽内已有的半张闭合;pair = 与本次拿的这张闭合;
   *  null = 不在下一步闭合范围内(激活为 pairs / lone)。
   *  同为 slot 与 pair 时记 slot(槽内半张先闭) */
  chain: ChainKind | null;
  /** 隐藏风险 [0,1]:预演露出的区域里代理看不到任何牌覆盖的占比——
   *  该「空白」可能是桌面,也可能是隐藏牌的顶面。**当前恒 0**(2026-11-23
   *  用户裁定:计算暂缓,另有后续计划);④后对账时可据此校准 */
  hiddenRisk: number;
}

/** 预演后仍不可点的直接目标(记是否「再拿一张就可点」) */
export interface ForecastNonClickable {
  tileId: number;
  /** near = 剩余直接遮挡者里有主观可点牌(再拿一张即可点,值 1);
   *  far = 剩余遮挡者全被压(值 0)。轮次口径,一跳数据可得 */
  near: boolean;
}

/** 揭示预演报告:假移除一张牌后,其直接覆盖的牌的预期变化 */
export interface RevealForecast {
  /** 被假想移除的牌 */
  removed: number;
  /** 预演后变可点的目标(按 tileId 升序) */
  clickable: ForecastClickable[];
  /** 预演后暴露增加但仍不可点的目标(按 tileId 升序) */
  nonClickable: ForecastNonClickable[];
  /** Σ 激活值(closes 1.0 / pairs 0.8 / lone 0.2)——求和不归一:
   *  揭 3 张优势牌好过 2 张(2026-11-23 裁定;布局规则下单次揭露 ≤ 4 张) */
  activationSum: number;
  /** near 张数(求和口径,与 activationSum 一致) */
  nearCount: number;
}

/** 激活类型的分值 */
const ACTIVATION_VALUE = { closes: 1.0, pairs: 0.8, lone: 0.2 } as const;

/**
 * 揭示预演:假想移除 removed 后,它**直接覆盖**的牌里哪些会变可点(2026-11-23)。
 *
 * 口径:
 *   · 假设集合 = perceived \ {removed},在其上重算遮挡(computeOcclusion,
 *     与等价定理同一套)——像素并集口径问像素口径的问题,不混用轮次量
 *   · 只看 occludesOf(removed) 的直接目标,不看传递闭包
 *   · clickable = 原 blocked ∧ 假设集合上 clickable;其余(暴露增加但仍被压)
 *     归 nonClickable
 *   · 激活判据(主观):closes 看槽内同元素(chain = slot),或与本次拿的这张
 *     同元素(chain = pair——它入槽后即是伴,2026-11-23 补:原实现把被拿的牌
 *     当作从游戏中消失,这类牌被误判为 lone);pairs 看感知集内同元素已识别牌
 *     且该牌在假设集合上亦可点(含「同批揭出」的双亮对)
 *
 * 主观盲区(系统性、方向性):m 原盖住的像素下可能有隐藏牌顶面露出,而隐藏牌
 *   不在感知集——预演看不见,故预演的可点性是**乐观估计**(只会多估)。
 *   这正是⑤预期的惊讶来源,不是 bug;hiddenRisk 字段为其量化预留位。
 *
 * 不预演深度:只做这一步(拿 removed → 看直接覆盖),不套娃;预算 = 广度
 *   即 occludesOf(removed) 的长度,布局规则下单次揭露 ≤ 4 张,无需截断。
 */
export function simulateReveal(
  removed: number,
  view: SubjectiveView,
  analysis: AnalysisResult,
): RevealForecast {
  const hypo = view.perceived.filter(t => t.tileId !== removed);
  const hypoDerived = computeOcclusion(hypo);
  const byId = new Map(view.perceived.map(t => [t.tileId, t]));
  const clickableNow = new Set<number>(
    view.perceived.filter(t => analysis.derived.get(t.tileId)?.clickable === true)
      .map(t => t.tileId));
  const slotElems = new Set(view.slot.map(s => s.elementId));
  // 被拿的牌入槽后即是其同元素的伴(身份未识别时无从判断)
  const removedTile = byId.get(removed);
  const removedElem = removedTile && removedTile.elementId !== UNKNOWN_ELEMENT
    ? removedTile.elementId : undefined;

  // 直接目标中,预演后变可点的牌(先收集,再逐张判激活——pairs 需要同批结果)
  const targets = [...(analysis.occludesOf.get(removed) ?? [])].sort((a, b) => a - b);
  const became: number[] = [];
  const nonClickable: ForecastNonClickable[] = [];
  for (const t of targets) {
    const wasBlocked = analysis.derived.get(t)?.clickable !== true;
    const nowClickable = hypoDerived.get(t)?.clickable === true;
    if (wasBlocked && nowClickable) {
      became.push(t);
    } else {
      // near:剩余直接遮挡者里有主观可点牌(仅对原本被压、预演后仍被压的目标)
      if (wasBlocked) {
        const rest = (analysis.blockersOf.get(t) ?? []).filter(b => b !== removed);
        nonClickable.push({ tileId: t, near: rest.some(b => clickableNow.has(b)) });
      }
    }
  }

  const clickable: ForecastClickable[] = became.map(t => {
    const tile = byId.get(t);
    let activation: ForecastClickable['activation'] = 'lone';
    let chain: ChainKind | null = null;
    if (tile && tile.elementId !== UNKNOWN_ELEMENT) {
      if (slotElems.has(tile.elementId)) {
        activation = 'closes';
        chain = 'slot';
      } else if (removedElem !== undefined && tile.elementId === removedElem) {
        activation = 'closes';
        chain = 'pair';
      } else {
        const identified = view.perceived.filter(p =>
          p.tileId !== t && p.tileId !== removed && p.elementId === tile.elementId);
        // 注:不用 Array.includes(ES2016)——编辑器编译目标的 lib 不含它
        // (与 Occlusion.flatMap 的历史问题同类,以工程级类型检查为准)
        const inBatch = (id: number): boolean => became.indexOf(id) >= 0;
        if (identified.length > 0 && identified.some(p =>
          clickableNow.has(p.tileId) || inBatch(p.tileId))) {
          activation = 'pairs';
        }
      }
    }
    return { tileId: t, activation, chain, hiddenRisk: 0 };
  });

  return {
    removed,
    clickable,
    nonClickable,
    activationSum: clickable.reduce((s, c) => s + ACTIVATION_VALUE[c.activation], 0),
    nearCount: nonClickable.filter(n => n.near).length,
  };
}
