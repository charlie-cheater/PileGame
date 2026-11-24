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
// 2026-11-23:reveal/groups/matches 全部内化为 analyze() 的产出
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
  /** 匹配机会报告(随分析产出) */
  matches: MatchReport;
}

/** ②分析:主观视图 → 结构认知 + 全部派生报告(揭露效能 / 同类归组 /
 *  匹配机会,2026-11-23 起全部内化为子属性)。
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
  // groups/matches 各自内部会再调 groupByIdentity,当前规模下重算可接受)
  const analysis = { edges, blockersOf, occludesOf, depth, closureSize, derived } as AnalysisResult;
  analysis.reveal = revealUtility(view, edges);
  analysis.groups = groupByIdentity(view, analysis);
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

// ─────────────────────────── 获取成本(v3 闭包口径,单一事实源) ───────────────────────────

/**
 * 获取成本(v3,2026-11-23 设计裁定):可点 1 / 被压 1 + 闭包大小。
 * 纯闭包口径——不再混入最长链深度(深度只回答轮次,不回答资源);
 * 闭包同时涵盖扇入宽度与链深。
 *
 * 用途:仅为**排序估计**——决定每元素的配对候选序(launcher = 成本最低者)。
 * 它不是消耗:配对的真实消耗以 MatchOpportunity.matchCost(消除模拟的
 * 净占用峰值)为准,两者不必有大小关系。
 */
export function flatCostOf(tileId: number, analysis: AnalysisResult): number {
  if (analysis.derived.get(tileId)?.clickable === true) return 1;
  return 1 + (analysis.closureSize.get(tileId) ?? 0);
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

/** 闭包成员索引工厂(记忆化 DFS over blockersOf,与 OcclusionTopology.allBlockers
 *  同源即 closureSize 的成员版;tileId 升序确定性输出)。匹配消耗的挖掘区
 *  与消除模拟的挖牌候选共用。 */
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

/** 配对候选牌(槽内或已识别 pile 牌) */
export interface MatchTileRef {
  tileId: number;
  /** 单张获取成本(闭包口径 = flatCostOf):槽内 0 / 可点 1 / 被压 1 + 闭包大小。
   *  仅用于配对候选排序(launcher = 成本最低者);不是消耗——
   *  真实消耗见 MatchOpportunity.matchCost(消除模拟的净占用峰值) */
  acquireCost: number;
  /** 闭包大小(遮挡传递闭包 = 全部揭露需先移除的牌数;可点/槽内 = 0) */
  revealCount: number;
  /** 是否已在槽中(成本 0 的启动牌) */
  inSlot: boolean;
}

/** 匹配类型(描述性分类,由两张牌的成本形态导出) */
export type MatchType = 'close' | 'double' | 'hold' | 'dig';

/** 匹配消耗的分解数据(消除模拟的记账结果;matchCost = peak) */
export interface MatchCostBreakdown {
  /** 挖掘区 = 闭包(launcher) ∪ 闭包(target) 的成员(tileId 升序)。
   *  并集口径:两牌共享的前置(遮挡拓扑上的共同路径)只计一次 */
  region: number[];
  /** 模拟开始时槽内已有的牌(既成事实,不计入净占用;被用于配对时净占用随之 −1) */
  preexisting: number[];
  /** 逐步净占用序列(每次拿牌后的阶段 2 读数;峰值 = 其最大值)。
   *  首元素对应 launcher 入槽(若 launcher 已在槽内则不入槽,序列从挖 target 起) */
  occupancy: number[];
  /** 模拟结束时槽内剩余的牌(出不去:伴被压或身份未知) */
  residual: number[];
  /** 模拟的拿牌次数 */
  steps: number;
}

export interface MatchOpportunity {
  elementId: string;
  /** 启动牌:配对两张中获取成本最低者(槽内牌成本 0,存在即恒为启动牌) */
  launcher: MatchTileRef;
  /** 目标牌:另一张(次低成本) */
  target: MatchTileRef;
  /** 匹配消耗 = 消除模拟的**净占用峰值**:完成这次配对,最多同时占几个新槽位。
   *  单位 = 槽位格数,可与空槽数直接比较(peak ≤ 空槽数 ⇔ 执行得下去)。
   *  空槽视为无限(模拟不因槽满中断);无论当前资源是否足够均计算 */
  matchCost: number;
  /** 消耗分解(挖掘区 / 原有槽内牌 / 占用序列 / 剩余) */
  cost: MatchCostBreakdown;
  type: MatchType;
  /** 当前空槽数是否不小于 matchCost(由模拟结果与资源直接比较得出) */
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
 * 匹配消耗(v4,2026-11-24 设计裁定——消除模拟的净占用峰值):
 *   · 每元素取获取成本最低的两张已识别候选牌(含槽内)组成最优配对
 *   · 启动牌 = 成本最低那张;槽内牌 = 成本 0 的启动牌
 *   · matchCost = 对挖掘区做一次消除模拟,记录**额外槽位占用的峰值**
 *
 * 模拟规则:
 *   · 空槽视为无限:不因槽满中断,挖掘区内可合并的配对最终一定合并
 *   · 每步四阶段:① 牌入槽占位 → ② 统计占用(**峰值在此读取**)→
 *     ③ 检查匹配并消除 → ④ 重新统计占用。峰值取消除之前——牌刚进槽、
 *     尚未配对时占用最高,这才是真实需要的空槽数
 *   · 净占用 = 槽内总数 − 模拟开始时已有的槽内牌数。原有牌被用于配对时
 *     总数减 1,净占用随之下降(「−1 处理」由此自然得出:闭包仅 1 张、
 *     槽内已持伴时,额外占用 = 1)
 *   · 挖牌:对 launcher、target 依次执行「反复拿它当前可点的闭包成员,直到它可点,
 *     再拿它」。候选只取该牌自己的闭包——不顺手拿别的东西;优先拿能立即闭对的。
 *     launcher 已在槽内则跳过。两牌共享的前置只被拿一次
 *   · 清槽:对槽内出不去的牌,**只在槽内牌与当前可点牌中**找伴——不找被
 *     遮盖的(递归深度超出一般人类的感知范围)。伴被压或身份未知的牌
 *     留在 residual,不计入峰值
 *
 * 取代的历史口径(均为对峰值的公式近似):v2.2 双口径平均、v3 闭包并集 −
 *   可合并项 + 待入槽张数、+1/+2 加项规则。共同路径只计一次(并集)、
 *   可合并项的消化、+1 还是 +2,现在是模拟的自然结果而非显式规则。
 *
 * 候选规则的推论(穷举 57699 组几何核实):挖掘区内若有 1 张同元素牌压着某候选,
 *   它必不比被压者贵,会被选为 target——「中间那张被选为 target」是规则的正确行为。
 *
 * 主观口径:全部基于感知视图;未识别/隐藏的牌不在候选与闭包内,峰值为真实值的下界。
 * 2026-11-23 起内化为 analyze 的产出步骤(随 AnalysisResult.matches 返回)。
 */
function matchOpportunities(view: SubjectiveView, analysis: AnalysisResult): MatchReport {
  const groups = groupByIdentity(view, analysis);
  const emptySlots = SLOT_COUNT - view.slot.length;
  const closureOf = makeClosureIndex(analysis);

  const opportunities: MatchOpportunity[] = [];

  groups.groups.forEach(g => {
    // 候选:槽内(至多 1 张,成本 0)+ 已识别 pile 牌(成本 = flatCostOf)
    const candidates: MatchTileRef[] = [];
    if (g.slot.length > 0) {
      candidates.push({ tileId: g.slot[0], acquireCost: 0, revealCount: 0, inSlot: true });
    }
    for (const r of g.pile) {
      candidates.push({
        tileId: r.tileId,
        acquireCost: flatCostOf(r.tileId, analysis),
        revealCount: analysis.closureSize.get(r.tileId) ?? 0,
        inSlot: false,
      });
    }
    if (candidates.length < 2) return;   // 伴不可见/单张:当前信息下不成对

    candidates.sort((a, b) => a.acquireCost - b.acquireCost || a.tileId - b.tileId);
    const launcher = candidates[0];
    const target = candidates[1];

    // 挖掘区:两牌闭包并集(共同路径只计一次;tileId 升序)
    const regionSet = new Set<number>();
    for (const id of closureOf(launcher.tileId)) regionSet.add(id);
    for (const id of closureOf(target.tileId)) regionSet.add(id);
    const region = [...regionSet].sort((a, b) => a - b);

    const sim = simulateMatch(view, launcher.tileId, target.tileId, region, closureOf);

    const type: MatchType =
      launcher.inSlot && target.revealCount === 0 ? 'close'
      : !launcher.inSlot && launcher.revealCount === 0 && target.revealCount === 0 ? 'double'
      : launcher.revealCount > 0 ? 'dig'
      : 'hold';

    opportunities.push({
      elementId: g.elementId, launcher, target,
      matchCost: sim.peak,
      cost: {
        region,
        preexisting: sim.preexisting,
        occupancy: sim.occupancy,
        residual: sim.residual,
        steps: sim.steps,
      },
      type,
      executable: emptySlots >= sim.peak,
    });
  });

  opportunities.sort((a, b) =>
    a.matchCost - b.matchCost || (a.elementId < b.elementId ? -1 : 1));

  const byType = { close: 0, double: 0, hold: 0, dig: 0 };
  opportunities.forEach(o => { byType[o.type]++; });

  return { opportunities, emptySlots, byType };
}

// ─────────────────────────── 消除模拟(匹配消耗的前向模型,主观) ───────────────────────────

interface MatchSimulation {
  /** 净占用峰值(= matchCost) */
  peak: number;
  /** 模拟开始时槽内已有的牌 */
  preexisting: number[];
  /** 逐步净占用序列(阶段 2 读数) */
  occupancy: number[];
  /** 结束时槽内剩余的牌 */
  residual: number[];
  /** 拿牌次数 */
  steps: number;
}

/**
 * 消除模拟:在主观视图上把 launcher 与 target 配掉,记账净占用峰值。
 *
 * 状态:removed = 已拿走的牌。可点性在「感知集 − removed」上重算
 * (computeOcclusion,与 simulateReveal 同一机制)——挖开一张,下面的牌才可点。
 * 槽内牌的身份:模拟开始时已有的取自 view.slot;模拟中拿进来的取自主观视图
 * (未识别牌以 UNKNOWN_ELEMENT 入槽,永不配对 → residual)。
 *
 * 拿牌优先级(确定性;模拟「一个不犯傻的玩家」):
 *   1. 挖某张牌时:其闭包内能立即闭对的成员优先,其余按 tileId 升序
 *   2. 清槽阶段:按入槽序检查槽内牌,为其找可点伴
 *
 * 逐步记账见 MatchCostBreakdown.occupancy。
 */
function simulateMatch(
  view: SubjectiveView,
  launcherId: number,
  targetId: number,
  region: ReadonlyArray<number>,
  closureOf: (id: number) => number[],
): MatchSimulation {
  const elemOf = new Map<number, string>();
  for (const t of view.perceived) elemOf.set(t.tileId, t.elementId);
  for (const s of view.slot) elemOf.set(s.tileId, s.elementId);

  const removed = new Set<number>();
  /** 模拟槽:tileId 列表(保持入槽序;消除时移除) */
  const slot: number[] = [];
  /** 模拟开始时槽内已有的牌(净占用的基数) */
  const preexisting: number[] = [];
  for (const s of view.slot) { slot.push(s.tileId); preexisting.push(s.tileId); }
  const base = slot.length;

  const occupancy: number[] = [];
  const residual: number[] = [];
  let peak = 0;
  let steps = 0;

  /** 当前主观可点牌(感知集 − removed 上重算) */
  const clickableNow = (): number[] => {
    const hypo = view.perceived.filter(t => !removed.has(t.tileId));
    const derived = computeOcclusion(hypo);
    const ids: number[] = [];
    for (const t of hypo) {
      if (derived.get(t.tileId)?.clickable === true) ids.push(t.tileId);
    }
    return ids.sort((a, b) => a - b);
  };

  /** 阶段 ③:槽内同元素配对全部消除(直到无对可消) */
  const settle = (): void => {
    let paired = true;
    while (paired) {
      paired = false;
      outer: for (let i = 0; i < slot.length; i++) {
        const e = elemOf.get(slot[i]);
        if (e === undefined || e === UNKNOWN_ELEMENT) continue;
        for (let j = i + 1; j < slot.length; j++) {
          if (elemOf.get(slot[j]) === e) {
            slot.splice(j, 1);
            slot.splice(i, 1);
            paired = true;
            break outer;
          }
        }
      }
    }
  };

  /** 仍在堆上的感知牌(未拿走、不在槽内) */
  const onPile = (id: number): boolean =>
    !removed.has(id) && !slot.some(x => x === id);

  /** 拿一张牌:阶段 ①②③④(只对仍在堆上的牌生效) */
  const take = (id: number): void => {
    if (!onPile(id)) return;
    removed.add(id);
    slot.push(id);                            // ① 入槽占位
    const net = slot.length - base;           // ② 统计占用 —— 峰值在此读取
    occupancy.push(net);
    if (net > peak) peak = net;
    settle();                                 // ③ 检查匹配并消除
    steps++;                                  // ④(占用由下次 ② 重读)
  };

  // ── 主循环:配掉 launcher 与 target ──
  // 挖开 goal:反复拿其当前可点的闭包成员,直到 goal 可点,再拿 goal。
  // 候选只取 goal 自己的闭包——不顺手拿别的东西。两牌共享的前置(共同路径)
  // 在挖第二张时已不在堆上,自然只计一次。
  const regionSet = new Set<number>(region);
  const digAndTake = (goal: number): void => {
    const own = new Set<number>(closureOf(goal));
    let guard = 0;
    while (!removed.has(goal) && guard++ < view.perceived.length + 4) {
      const click = clickableNow();
      if (click.some(id => id === goal)) { take(goal); return; }
      // 候选:可点 ∧ 属于 goal 的闭包 ∧ 属于挖掘区 ∧ 仍在堆上
      const cands = click.filter(id => own.has(id) && regionSet.has(id) && onPile(id));
      if (cands.length === 0) break;            // 闭包挖空仍不可点(隐藏牌所致):中止
      // 优先拿能立即闭对的;同级 tileId 升序
      const slotElems = new Set(slot.map(id => elemOf.get(id)));
      const closing = cands.filter(id => slotElems.has(elemOf.get(id)));
      take((closing.length > 0 ? closing : cands)[0]);
    }
  };

  // launcher 已在槽内(模拟开始时持有的那张)则不再入槽——它的占位是既成事实
  if (!preexisting.some(id => id === launcherId)) digAndTake(launcherId);
  digAndTake(targetId);

  // ── 清槽:槽内出不去的牌,只在槽内与当前可点牌中找伴 ──
  let acted = true;
  let guard = 0;
  while (acted && guard++ < view.perceived.length + 4) {
    acted = false;
    const click = clickableNow();
    // 按入槽序逐张检查(每轮重读,消除后序号变化)
    for (let i = 0; i < slot.length; i++) {
      const x = slot[i];
      const e = elemOf.get(x);
      if (e === undefined || e === UNKNOWN_ELEMENT) continue;
      // 槽内已有伴 → settle 已处理(或本轮稍后处理);只找可点伴
      const mate = click.find(id => onPile(id) && elemOf.get(id) === e);
      if (mate !== undefined) { take(mate); acted = true; break; }
    }
  }

  for (const id of slot) residual.push(id);
  return { peak, preexisting, occupancy, residual, steps };
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
