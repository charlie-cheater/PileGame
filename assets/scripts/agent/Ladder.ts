// ============================================================================
// Ladder.ts — 仿真玩家代理 · ③决策 扫描梯瀑布骨架(2026-11-23 设计评审通过)
//
// 架构(三元组契约):
//   决策以「扫描梯」模式围绕分析数据思考:梯 = 有序的 DecisionRung 数组,
//   依序过梯,首个非空胜出;全空 → 内置 fallback 兜底(瀑布永有产出)。
//   每梯产出 AgentOperation = 动作 + 原因(命中的规则 + 证据)+ 预期
//   (三字段微预测)——预期即 ⑤预期阶段的对账面:④执行后与实际感知比对,
//   误差 = 惊讶度信号(难度感知原料)。
//
// 插拔协议:
//   · 梯 = 纯数据数组,增删/换序即重构决策人格;defaultLadder 为休闲基线
//   · 自定义梯只需实现 DecisionRung(rule 标识 + decide(ctx) → op | null)
//   · ladderPolicy() 把梯桥接为 Runner 的 decision 策略
//
// 优先级裁定(2026-11-23,与设计稿表格的偏差及依据):
//   slot-close 先于 pair-complete——设计稿原列 pair-complete 居先,但
//   平盘推演证伪:pair-complete 先行会连续持半(E1a→E2a→E3a→E4a)槽满
//   判负;slot-close 先行则逐对闭合清盘。2026-11-24 起 pair-complete 只收
//   可执行的 double(空槽 < 2 让位),连续持半致判负的情形已被门槛排除;
//   先后顺序仍影响槽压峰值(先闭合再开对,峰值更低)。
//
// 梯序(休闲基线 defaultLadder):slot-close → pair-complete → dig → explore
//   每个梯在自己负责的 match 类型所涉及的牌上做比较:slot-close 收 close 型的目标牌,
//   pair-complete 收可执行 double 型里的牌,dig 收其余可执行匹配(hold / dig 型)的首牌,
//   explore 接手「无可执行匹配」的局面(不收匹配,按揭露量与自身风险选牌)。
//   wander(均匀随机)保留为对照基线,不在默认梯。
//   ⛔ 启动梯 startup(2026-11-25 插入、同日移除):槽空时在全部可执行匹配里择优启动。
//   设计者指出任何一张牌都会有相关的 hold / dig 配对,择优统一用推进效能后它没有
//   独立职责,予以移除。
//   原 chain 梯(借槽两步闭合,2026-11-23)已于 2026-11-24 整体移除:其两类机会
//   在 MatchReport 中均为可执行的 hold 型匹配,由 dig 梯覆盖。
//
// 择优依据(2026-11-25 设计者设计:推进效能):三个择优梯统一在**各自负责的牌**上比
//   「拿走这张牌让盘面上的挖掘路线向前走了多少、这些路线值多少」(见 advanceOf)。
//   取代此前的拾取差分(2026-11-24:新增可执行 > 类型升级 > 峰值下降,按元素计)——
//   差分粒度是元素,推进效能的粒度是配对(按元素归并)。
//   ⛔ 拾取差分 pickDelta / comparePickDelta / deltaScore 保留为对照基线与历史参照,
//   不再参与任何默认梯的择优。
//
// 候选去重口径:三个择优梯的候选都**按牌去重**,同一张牌每次决策只算一次推进效能。
//
// dig 梯(2026-11-25 设计者定稿的报告/验算分工;同日指示报告期对全部配对验算):
//   报告期记录每个元素的全部配对并分类、**逐条验算**(消耗与滞留牌)。dig 出手时
//   直接读报告筛可执行的 hold / dig,在其首牌上比推进效能。清单事实记入
//   reason.scan 随轨迹落盘(批量观测用 tools/agent-observe.js)。
//
// 人类可信度边界:单遍扫描不回溯;expectation 只预测「下一步感知可验证」的字段。
// ============================================================================

import { Tile } from '../core/tile';
import { SubjectiveView, UNKNOWN_ELEMENT } from './Perception';
import { analyze, AnalysisResult, MatchOpportunity, MatchReport, MatchType,
  RevealForecast, simulateReveal } from './Analysis';

// ─────────────────────────── 契约类型 ───────────────────────────

/** 思考模式(扫描梯的梯名;fallback = 内置安全网,非可插拔梯) */
export type DecisionRule =
  | 'slot-close'     // 闭合槽内半张(close 型匹配)
  | 'pair-complete'  // 双亮对折叠(P2;可执行 double 型匹配)
  | 'dig'            // 启动需挖掘的匹配(可执行 hold / dig 型匹配)
  | 'explore'        // 寻找新的潜在可能性(无可执行匹配时,按揭露量买信息)
  | 'wander'         // 均匀随机(对照基线,不在默认梯)
  | 'fallback';      // 内置兜底

/** 匹配的结构化引用(启动梯 / dig 梯所选,随操作落盘) */
export interface ChosenMatch {
  elementId: string;
  /** 匹配类型(启动梯可能记 double 等任意类型;dig 梯记 hold / dig) */
  type: MatchType;
  /** 启动牌 */
  launcher: number;
  /** 目标牌 */
  target: number;
  /** 消耗 = 消除模拟的净占用峰值(槽位格数) */
  matchCost: number;
}

/** dig 梯的观测记录(2026-11-25;随操作落盘)。报告期已对全部配对(含 hold / dig)
 *  验算,出手时直接读报告——这里记该决策的 hold / dig 清单事实,供批量观测汇总 */
export interface DigScanTrace {
  /** 报告里的 hold / dig 配对数(报告期已全部验算) */
  pairs: number;
  /** 其中可执行(峰值 ≤ 空槽)的配对数 */
  executable: number;
  /** 涉及的元素数 */
  elements: number;
}

/** 一次拾取前后分析数据的差异(2026-11-24 设计定论:决策只产生「拾取一张牌」,
 *  故可预演拾取 → 对新盘面重新分析 → 比较差异 → 量化收益)。详见 pickDelta */
export interface PickDelta {
  /** 拾取后新增的「可执行」元素数:原先没有可执行的配对、现在有了 */
  newExecutable: number;
  /** 类型升级数:最好可达等级上升的元素数(dig → hold → double → close)。
   *  含 新出现就是 close / double 的元素 */
  upgrades: number;
  /** 峰值下降总量:各元素最低消耗在拾取前后的正向差值之和 */
  peakDrop: number;
  /** 诊断明细 */
  detail: {
    appeared: string[];      // 新出现的元素(元素:最好类型)
    disappeared: string[];   // 消失的元素(元素:最好类型)
    upgraded: string[];      // 类型升级(元素:旧→新)
    newExecIds: string[];    // 新增可执行的元素(元素:最好类型)
  };
}

/** 执行原因(结构化) */
export interface OperationReason {
  rule: DecisionRule;
  /** 证据摘要(自由短句;可读性优先) */
  note?: string;
  /** 梯内效能得分(平级择优的胜出分;骨架期即接入) */
  utility?: number;
  /** 梯内次优候选(效用差 = 猩豫度原料) */
  runnerUp?: { tileId: number; score: number };
  /** dig 梯专用:本次启动的匹配 */
  match?: ChosenMatch;
  /** dig 梯专用:验算观测记录(出手时才有) */
  scan?: DigScanTrace;
  /** 拾取差分(slot-close / pair-complete / dig 的择优依据,随操作落盘;含三级分量与明细) */
  delta?: PickDelta;
  /** 推进效能(2026-11-25 设计者设计;详见 advanceOf) */
  advance?: PickAdvance;
}

/** 推进效能的明细:拿一张牌 = 推进与之路径有交集的全部 hold / dig 配对,
 *  按元素归并(同元素的各条配对争的是同一个配对容量,只记最好的一条)后求和 */
export interface PickAdvance {
  /** 总效能 = 各元素最优配对的价值之和 */
  total: number;
  /** 归并后的逐元素明细(按元素名升序) */
  elements: AdvanceEntry[];
}

/** 一个元素被推进的最好一条配对及其价值构成 */
export interface AdvanceEntry {
  elementId: string;
  /** 所计的那条配对(拿后报告中的身份;无序 tileId 对,升序) */
  pairId: readonly [number, number];
  /** 推进后到配对完成还差的拿牌数(= 拿前 pairPicks − 1) */
  pairPicks: number;
  /** 滞留牌数(拿前 residual:这条路线自己带入而出不去的牌,不含槽内原有的牌;
   *  观测用原始值,不施加「拿牌顺序 < 空槽数」的计入约束) */
  residual: number;
  /** 槽内遗留牌的同类抵消数:闭包里有其同类牌的槽内遗留牌张数(每张使有效滞留 −1) */
  offset: number;
  /** 是否可执行(取**拿前**;不可执行的路线推进价值 × 0.1) */
  executable: boolean;
  /** 价值 = 1 / (推进后 pairPicks + max(0, 计入滞留数 − 同类抵消数)) × (可执行 ? 1 : 0.1)。
   *  计入滞留数 = 拿牌顺序下标 < 当前空槽数的滞留牌张数 */
  value: number;
}

/** 预期结果(④执行后一步感知即可对账;forecast = ⑤预期阶段的前向模型产出) */
export interface OperationExpectation {
  /** 预期本次拾取闭对(伴已知在槽) */
  pairCompletes: boolean;
  /** 预期结算后槽位占用(闭对 S-1 / 普通 S+1) */
  slotAfter: number;
  /** 预期新揭露变可点的 tileId(= forecast.clickable;主乐观估计) */
  exposes: number[];
  /** 把握度:certain 伴在槽 / likely 伴在堆可见 / guess 身份未知 */
  confidence: 'certain' | 'likely' | 'guess';
  /** 揭示预演报告(拿走这张牌后其直接覆盖的牌的预期变化;可对账) */
  forecast: RevealForecast;
}

/** ③决策的输出:移除动作 + 原因 + 预期 */
export interface AgentOperation {
  /** v1 仅 pick;type 预留 recall/shuffle(道具,代理尚未建模) */
  action: { type: 'pick'; tileId: number };
  reason: OperationReason;
  expectation: OperationExpectation;
}

/** 轨迹落盘用的操作摘要(Runner StepRecord.operation) */
export interface OperationTrace {
  rule: DecisionRule;
  note?: string;
  utility?: number;
  runnerUp?: { tileId: number; score: number };
  /** dig 梯所选中的匹配 */
  match?: ChosenMatch;
  /** dig 梯的清单事实(报告里的 hold / dig 配对数 / 可执行数 / 元素数) */
  scan?: DigScanTrace;
  /** 拾取差分(择优改用差分的梯) */
  delta?: PickDelta;
  /** 推进效能(择优改用推进效能的梯) */
  advance?: PickAdvance;
  expectation: OperationExpectation;
}

/** 决策上下文(与 Runner 逐步构建的视图/分析同源;全部主观) */
export interface LadderContext {
  view: SubjectiveView;
  analysis: AnalysisResult;
  /** 主观可点牌 */
  clickable: ReadonlyArray<Tile>;
  rng: () => number;
}

/** 一级阶梯:审视上下文,出手(返回 Operation)或让位(返回 null) */
export interface DecisionRung {
  readonly rule: DecisionRule;
  decide(ctx: LadderContext): AgentOperation | null;
}

/** v2 决策策略:产出 Operation(Runner params.decision 消费) */
export type DecisionPolicy = (ctx: LadderContext) => AgentOperation;

// ─────────────────────────── 预期构建(③→⑤ 对账面) ───────────────────────────

/** 为一次拾取构建预期(各梯共用,保证对账口径一致):三字段微预测 + 揭示预演 */
export function expectForPick(
  tileId: number,
  ctx: LadderContext,
  confidence?: OperationExpectation['confidence'],
): OperationExpectation {
  const tile = ctx.view.perceived.find(t => t.tileId === tileId)
    ?? ctx.view.slot.find(s => s.tileId === tileId);
  const slotMate = tile && tile.elementId !== UNKNOWN_ELEMENT
    ? ctx.view.slot.find(s => s.elementId === tile.elementId)
    : undefined;
  const pairCompletes = !!slotMate;
  const S = ctx.view.slot.length;
  const forecast = simulateReveal(tileId, ctx.view, ctx.analysis);
  const conf = confidence
    ?? (pairCompletes ? 'certain'
      : !tile || tile.elementId === UNKNOWN_ELEMENT ? 'guess' : 'likely');
  return {
    pairCompletes,
    slotAfter: pairCompletes ? S - 1 : S + 1,
    exposes: forecast.clickable.map(c => c.tileId),
    confidence: conf,
    forecast,
  };
}

/** 随机拾取 op(wander / fallback 共用;骨架级均匀采样,显著度加权待人格批) */
function randomPickOp(rule: DecisionRule, ctx: LadderContext): AgentOperation {
  if (ctx.clickable.length === 0) {
    return {
      action: { type: 'pick', tileId: -1 },
      reason: { rule, note: '无可点牌(异常路径)' },
      expectation: { pairCompletes: false, slotAfter: ctx.view.slot.length, exposes: [],
        confidence: 'guess',
        forecast: { removed: -1, clickable: [], nonClickable: [], activationSum: 0, nearCount: 0 } },
    };
  }
  const i = Math.floor(ctx.rng() * ctx.clickable.length);
  const t = ctx.clickable[Math.min(i, ctx.clickable.length - 1)];
  return {
    action: { type: 'pick', tileId: t.tileId },
    reason: { rule, note: '无信号,均匀采样(骨架级;显著度加权待人格批)' },
    expectation: expectForPick(t.tileId, ctx),
  };
}

// ─────────────────────────── 梯内平级择优(拾取差分,字典序) ───────────────────────────

/** 匹配的可达性等级(字典序第二级「类型升级」的度量:数值上升 = 升级) */
const REACH_RANK: Record<MatchType, number> = { dig: 0, hold: 1, double: 2, close: 3 };

/** 一个元素的匹配概况:名下全部配对里最好的可达等级、最低的消耗、有无可执行的配对。
 *  2026-11-25 报告期全量验算后,三个字段覆盖全部类型(minCost 不再有 Infinity 语义) */
interface ElementReach {
  bestRank: number;
  minCost: number;
  executable: boolean;
}

/** 可达等级 → 类型名(明细用;与 REACH_RANK 的取值对应) */
const RANK_TYPE: MatchType[] = ['dig', 'hold', 'double', 'close'];

function reachOf(report: MatchReport): Map<string, ElementReach> {
  const result = new Map<string, ElementReach>();
  for (const o of report.opportunities) {
    const rank = REACH_RANK[o.type];
    const r = result.get(o.elementId);
    if (!r) {
      result.set(o.elementId, { bestRank: rank, minCost: o.matchCost ?? Infinity, executable: o.executable === true });
    } else {
      if (rank > r.bestRank) r.bestRank = rank;
      if (o.matchCost !== undefined && o.matchCost < r.minCost) r.minCost = o.matchCost;
      if (o.executable === true) r.executable = true;
    }
  }
  return result;
}

/**
 * 拾取差分:预演拾取 tileId → 重新分析 → 与原分析比较。
 *
 * **按元素计数**(2026-11-24 设计裁定;配对保留扩展后同一元素名下可有多条配对,
 * 按配对数会让「同元素看得见的牌越多、差分越大」):
 *   · 新增可执行 = 原先没有可执行配对、现在有了的元素数
 *   · 类型升级 = 最好可达等级上升的元素数(新出现的元素,等级到 double 及以上才计)
 *   · 峰值下降总量 = 各元素最低消耗的正向差值之和
 * 三个分量按字典序择优,见 comparePickDelta。
 *
 * 分量口径(2026-11-25 报告期全量验算后恢复):报告期对所有配对(含 hold / dig)
 * 模拟,故「新增可执行 / 峰值下降」覆盖全部类型——「挖掘变便宜」重新可见;
 * 「类型升级」由分类得出。
 *
 * 预演范围(2026-11-24 设计裁定):**只在当前感知集上进行**——新露出的牌不进预演,
 * 操作落定后由下一轮 ①感知 → ②分析 纳入。预演是代理决策时的预期,不含尚未
 * 看见的牌;因此预演的收益是真实收益的下界(揭出越多越保守)。
 * 槽内状态变化纳入预演:拾取导致闭对则两张离场,后续匹配的可执行性按
 * **合并后的资源余量**判定(由 analyze 依新视图的 slot.length 自动得出)。
 * 纯函数:在视图的拷贝上模拟,不修改 ctx.view 与真实 Board(无需状态恢复)。
 */
export function pickDelta(tileId: number, ctx: LadderContext): PickDelta {
  const after = simulateAnalysisAfterPick(tileId, ctx);
  const before = reachOf(ctx.analysis.matches);
  const afterMap = reachOf(after.matches);

  const appeared: string[] = [];
  const disappeared: string[] = [];
  const upgraded: string[] = [];
  const newExecIds: string[] = [];
  let newExecutable = 0;
  let upgrades = 0;
  let peakDrop = 0;
  for (const [elementId, a] of afterMap) {
    const b = before.get(elementId);
    if (!b) appeared.push(`${elementId}:${RANK_TYPE[a.bestRank]}`);
    // 新增可执行:现在有可执行的配对,而原先没有(或原先根本没有配对)
    if (a.executable && !(b && b.executable)) {
      newExecutable++;
      newExecIds.push(`${elementId}:${RANK_TYPE[a.bestRank]}`);
    }
    // 升级:最好可达等级上升;新出现的元素要到 double 及以上才算
    // (等价于此前「新出现的 close / double 型」)
    if (b ? a.bestRank > b.bestRank : a.bestRank >= REACH_RANK.double) {
      upgrades++;
      upgraded.push(`${elementId}:${b ? RANK_TYPE[b.bestRank] : '无'}→${RANK_TYPE[a.bestRank]}`);
    }
    // 峰值下降:该元素最低消耗的正向差值(报告期全量验算后覆盖全部类型)
    if (b && isFinite(b.minCost) && isFinite(a.minCost) && b.minCost > a.minCost) {
      peakDrop += b.minCost - a.minCost;
    }
  }
  for (const [elementId, b] of before) {
    if (!afterMap.has(elementId)) disappeared.push(`${elementId}:${RANK_TYPE[b.bestRank]}`);
  }

  return {
    newExecutable, upgrades, peakDrop,
    detail: { appeared, disappeared, upgraded, newExecIds },
  };
}

/** 字典序比较差分:新增可执行 > 类型升级 > 峰值下降总量。
 *  正数 = a 优于 b;0 = 平级;负数 = a 劣于 b。 */
export function comparePickDelta(a: PickDelta, b: PickDelta): number {
  if (a.newExecutable !== b.newExecutable) return a.newExecutable - b.newExecutable;
  if (a.upgrades !== b.upgrades) return a.upgrades - b.upgrades;
  return a.peakDrop - b.peakDrop;
}

/** 差分的标量化(保序:与 comparePickDelta 同序)。仅供犹豫度(utility − runnerUp)
 *  与轨迹落盘使用;择优比较一律走 comparePickDelta,不用本值。
 *  进位取足够大的基数,使低一级的差不会越级 */
export function deltaScore(d: PickDelta): number {
  const BASE = 1000000;
  return (d.newExecutable * BASE + d.upgrades) * BASE + d.peakDrop;
}

/** 按拾取差分择优:字典序最大者;平分取 tileId 小者(确定性)。
 *  候选可以是任意类型,包括数值 0 这类假值(两个择优梯直接传 tileId)——
 *  「是否已有胜出者」用 found 记,不拿候选本身判真伪 */
function pickBestByDelta<T>(
  candidates: ReadonlyArray<T>,
  idOf: (t: T) => number,
  deltaOf: (t: T) => PickDelta,
): { pick: T; delta: PickDelta; runnerUp?: { tileId: number; delta: PickDelta } } {
  let found = false;
  let best: T | null = null;
  let bestDelta: PickDelta | null = null;
  let bestId = 0;
  let runnerUp: { tileId: number; delta: PickDelta } | undefined;
  for (const c of candidates) {
    const d = deltaOf(c);
    const id = idOf(c);
    if (!found || comparePickDelta(d, bestDelta!) > 0
        || (comparePickDelta(d, bestDelta!) === 0 && id < bestId)) {
      if (found) runnerUp = { tileId: bestId, delta: bestDelta! };
      best = c;
      bestDelta = d;
      bestId = id;
      found = true;
    } else if (!runnerUp || comparePickDelta(d, runnerUp.delta) > 0) {
      runnerUp = { tileId: id, delta: d };
    }
  }
  return { pick: best!, delta: bestDelta!, runnerUp };
}

/** 模拟拾取一张牌后的主观视图(拾取 → 自动配对结算)。
 *  在主观视图的拷贝上做,不触碰真实 Board。结算规则与 Board.pick 一致:
 *  拾取的牌进槽;槽内若有其同元素牌(身份未识别的牌不参与),两张立即配对离场。 */
export function simulateViewAfterPick(tileId: number, view: SubjectiveView): SubjectiveView {
  const picked = view.perceived.find(t => t.tileId === tileId);
  if (!picked) return view;                      // 不在感知集:无可预演
  const perceived = view.perceived.filter(t => t.tileId !== tileId);
  const slot = view.slot.map(s => ({ ...s }));
  if (picked.elementId !== UNKNOWN_ELEMENT) {
    const m = slot.findIndex(s => s.elementId === picked.elementId);
    if (m >= 0) slot.splice(m, 1);               // 闭对:槽内伴与拾取牌一并离场
    else slot.push({ ...picked });               // 非闭对:进槽持有
  } else {
    slot.push({ ...picked });                    // 未识别:进槽,待入槽后识别
  }
  return { perceived, slot, exposure: new Map(), totalPileCount: view.totalPileCount - 1 };
}

/** 模拟拾取一张牌后的主观分析 = 对拾取后的视图重新执行 ②分析。
 *  等价于「这张牌被拿走后,代理再看一次盘面」。 */
export function simulateAnalysisAfterPick(tileId: number, ctx: LadderContext): AnalysisResult {
  return analyze(simulateViewAfterPick(tileId, ctx.view));
}

// ─────────────────────────── 推进效能(拿一张牌推进了哪些挖掘路线) ───────────────────────────

/** 不可执行的路线推进价值的折减系数(2026-11-25 设计者裁定) */
const ADVANCE_INEXECUTABLE = 0.1;
/** 每张滞留牌等价的拿牌数(加进进度的分母;2026-11-25 设计者同意 k = 1 起步) */
const ADVANCE_RESIDUAL_PICKS = 1;
/** 外部资源使用计数的能效代价(2026-11-27 设计者指示试验;默认 1):路线每引用
 *  一张闭包以外的牌(清槽 / settle 的外部伴),能效分母 + 此权重——外部引用越少,
 *  能效越高。消融对照:temp 树打补丁(0 / 0.5 / 1 / 2) */
const ADVANCE_EXTERNAL_PICKS = 0; // 消融(2026-11-27,各 150 局):0/0.5/1/2 → 14 元素 84.7/85.3/83.3/83.3,23 元素 10.0/9.3/9.3/8.7——权重越大越差,默认 0(机制保留为旋钮)

/**
 * 推进效能:量化「拿走 tileId 让盘面上的哪些挖掘路线向前走了一步、这些路线值多少」
 * (2026-11-25 设计者设计;取代拾取差分作为按 match 评估的粒度)。
 *
 * **直接从当前报告计算,不做预演**(2026-11-26 设计者指示「去掉预演」):拿走一张牌
 * 让一条路线近了多少,由这条配对自己的执行计划(`cost.picks` / `cost.pairPicks`)
 * 直接读出,不必把拿后的盘面重新分析一遍——预演曾占总耗时 40~84%。
 *
 * 口径:
 *   · 相关配对 R = 报告里**闭包(`cost.region`)含 tileId、且 tileId 不是配对牌**的
 *     全部 hold / dig 配对(2026-11-26 设计者裁定)。即:这张牌是这条路线要清掉的
 *     纯遮挡者。拿配对牌本身(可点的启动牌、或被压的目标牌)不计——拿它是在「把这张
 *     牌自己送去配对」,不是在推进别的路线
 *     - 闭包里的牌一定在拿牌路径 picks 里,且不会落在配对完成之后的清槽段
 *       (实测 3430 组:闭包 ⊂ picks;闭包内的牌 2.4% 是配对牌、97.6% 在到配对完成的
 *       路径上、0% 只在清槽段)——故无须再单独排除清槽尾巴与「拿配对牌使配对作废」
 *   · 单条配对的价值由**配对自身的属性**决定:
 *       value = 1 / (推进后 pairPicks + 有效滞留 × k) × (可执行 ? 1 : 0.1)
 *     - 推进后 pairPicks = 拿前 pairPicks − 1(这一拿恰是路径上的一步)
 *     - 进度取倒数:越接近完成的路线,推进它越值钱(差 1 拿 = 1.0,差 4 拿 = 0.25)
 *     - 滞留牌按 k = 1 折算成额外拿牌数加进分母:走完会留尾巴的路线,推进它要打折扣
 *       (乘性折减而非加性减分——价值恒正,「近但脏」不会被判成负收益)。
 *       滞留取 `cost.residual`:这条路线自己带入而出不去的牌。
 *       **计入约束**(2026-11-26 设计者指示):设当前空槽数为 n、某张滞留牌在模拟
 *       拿牌顺序(`cost.picks` 下标)为 m,仅当 m < n 时这张滞留牌才计入分母——
 *       空槽耗尽之后才拿进来的滞留,不在「这次决策关心的占用窗口」内
 *     - **槽内遗留牌的同类抵消**(2026-11-26 设计者指示):这条路线的闭包里若有
 *       槽内某张遗留牌的同类牌,挖开时它能跟槽里那张配掉、腾回一格——每有一张这样的
 *       遗留牌,有效滞留减 1(不减穿 0;配对牌自己在槽内的那张不算遗留,不参与抵消)。
 *       `residual` 字段本身仍只记路线带入的滞留,抵消只发生在效能的分母里
 *     - 不可执行的路线 × 0.1:现在做不动的只是储备,不是 0(推进它可能让它变可执行)
 *   · 已知偏差(不作预演就看不见):实测约 13% 的情形这一拿连带省掉了后面的牌
 *     (实际推进 2 拿或更多),按 1 计——效能是真实收益的偏保守估计
 *   · **按元素归并**:全量清单下同元素的各条配对是彼此独立的路线(路径重叠仅 5~8%,
 *     按路径归并不去冗余),但它们争的是同一个配对容量——每个元素只记名下价值
 *     最大的一条,跨元素求和(不同元素的路线要挖的牌不同,一子两用是真实收益)
 *
 * 纯函数:只读 ctx.analysis,不修改任何状态。
 */
export function advanceOf(tileId: number, ctx: LadderContext): PickAdvance {
  const report = ctx.analysis.matches;
  // tileId → 元素(感知牌 + 槽内牌;闭包成员都在感知集里,槽内牌用于识别遗留牌的元素)
  const elemOf = new Map<number, string>();
  for (const t of ctx.view.perceived) elemOf.set(t.tileId, t.elementId);
  for (const s of ctx.view.slot) elemOf.set(s.tileId, s.elementId);

  // 逐元素取价值最大的一条(平分取 pairId 字典序小者,确定性)
  const best = new Map<string, AdvanceEntry>();
  for (const m of report.opportunities) {
    if (m.type !== 'hold' && m.type !== 'dig') continue;
    // (不用 Array.includes(ES2016)——编辑器编译目标的 lib 不含它,以工程级类型检查为准)
    // 相关:这张牌在闭包里(这条路线要清掉它),且不是配对牌本身
    if (m.cost.region.indexOf(tileId) < 0) continue;
    if (m.pairId[0] === tileId || m.pairId[1] === tileId) continue;
    const after = m.cost.pairPicks - 1;
    if (after <= 0) continue;                            // 配对未完成(目标不可达),无从比较
    const residual = m.cost.residual.length;
    // 计入约束:只数「拿牌顺序下标 < 当前空槽数」的滞留牌(下标 0 起;
    // 不在 picks 里的残牌不会出现,防御性跳过)。residual 字段仍记全部滞留,供观测
    const residualActive = m.cost.residual.filter(id => {
      const order = m.cost.picks.indexOf(id);
      return order >= 0 && order < report.emptySlots;
    }).length;
    // 槽内遗留牌的同类抵消:闭包里每有一种「槽内遗留牌的同类牌」,有效滞留 −1。
    // 遗留牌 = 槽内除本配对两张之外的已识别牌(配对牌自己在槽里的是启动牌,不是遗留)
    const regionElems = new Set<string>();
    for (const id of m.cost.region) {
      const e = elemOf.get(id);
      if (e !== undefined && e !== UNKNOWN_ELEMENT) regionElems.add(e);
    }
    let offset = 0;
    for (const s of ctx.view.slot) {
      if (s.elementId === UNKNOWN_ELEMENT) continue;
      if (s.tileId === m.pairId[0] || s.tileId === m.pairId[1]) continue;
      if (regionElems.has(s.elementId)) offset++;
    }
    const effective = Math.max(0, residualActive - offset);
    const value = 1 / (after + effective * ADVANCE_RESIDUAL_PICKS
      + (m.cost.external ?? 0) * ADVANCE_EXTERNAL_PICKS)
      * (m.executable === true ? 1 : ADVANCE_INEXECUTABLE);
    const entry: AdvanceEntry = {
      elementId: m.elementId,
      pairId: m.pairId,
      pairPicks: after,
      residual,
      offset,
      executable: m.executable === true,
      value,
    };
    const cur = best.get(m.elementId);
    if (cur === undefined || entry.value > cur.value
      || (entry.value === cur.value && entry.pairId.join(':') < cur.pairId.join(':'))) {
      best.set(m.elementId, entry);
    }
  }
  const elements = [...best.values()].sort((a, b) =>
    (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0));
  return {
    total: elements.reduce((s, e) => s + e.value, 0),
    elements,
  };
}

/** 按推进效能择优的结果(三个择优梯共用) */
export interface AdvancePick {
  /** 所拿的牌 */
  tileId: number;
  /** 所拿牌的推进效能(随操作落盘) */
  advance: PickAdvance;
  /** 次优候选(效能差 = 犹豫度原料) */
  runnerUp?: { tileId: number; advance: PickAdvance };
}

/** 按推进效能择优:效能最大者;平分取 tileId 小者(确定性)。
 *  同一张牌只算一次效能(按牌缓存)。「是否已有胜出者」用 found 记,不拿候选
 *  本身判真伪(候选 tileId 可以是 0) */
function pickBestByAdvance(tileIds: ReadonlyArray<number>, ctx: LadderContext): AdvancePick | null {
  const cache = new Map<number, PickAdvance>();
  const advanceOfTile = (id: number): PickAdvance => {
    let a = cache.get(id);
    if (!a) { a = advanceOf(id, ctx); cache.set(id, a); }
    return a;
  };
  let found = false;
  let best = 0;
  let bestAdvance: PickAdvance | null = null;
  let runnerUp: { tileId: number; advance: PickAdvance } | undefined;
  for (const id of tileIds) {
    const a = advanceOfTile(id);
    if (!found || a.total > bestAdvance!.total) {
      if (found) runnerUp = { tileId: best, advance: bestAdvance! };
      best = id;
      bestAdvance = a;
      found = true;
    } else if (!runnerUp || a.total > runnerUp.advance.total) {
      runnerUp = { tileId: id, advance: a };
    }
  }
  if (!found) return null;
  return { tileId: best, advance: bestAdvance!, runnerUp };
}

/** 效能的 note 片段:总量与推进到的元素数 */
function advanceNote(a: PickAdvance): string {
  return `效能 ${a.total.toFixed(3)}(${a.elements.length} 个元素)`;
}

// ─────────────────────────── 示范梯(休闲基线) ───────────────────────────

/** ⛔ 实验开关(默认关;2026-11-26 设计者批准对照):dig 短路线优先——dig 致死手
 *  18 例的共同特征是「低槽压时启动长路线」(pairPicks 均值 6.3 对健康 4.9,残留
 *  1.5 对 0.97,零裕量 16/18;18/18 致命牌在见证中更晚出现 = 拿早了)。开启后
 *  dig 的候选先收窄到 pairPicks 最小的组,效能只在组内比较(见 selectDig)。
 *  注意:开对时序与闭对时序同源,本开关与 SLOT_CLOSE_YIELD 不建议同时开启。
 *  由对照裁决去留 */
export const DIG_SHORT_FIRST = false;

/** ⛔ 实验开关(默认关;2026-11-26 设计者批准对照):slot-close 让位——闭对的
 *  尾配对不可执行(退化 / 不可评估),而同一槽内牌另有**可执行的 hold 路线**
 *  且其尾配对可执行时,本梯让位给 dig(闭对时机会改变元素的奇偶开对窗,见
 *  归因:23 元素档 7 例致死闭对;seed 1107 步 13 为实证反例)。代价:重新打开
 *  「连续持半判负」的风险面(闭对不再无条件先行),由对照裁决去留 */
export const SLOT_CLOSE_YIELD = false;

/** 尾均步加权强度(2026-11-27 设计者,默认 1):合并类择优的排序值 =
 *  推进效能 / (1 + w × 尾配对平均 pairPicks)。0 = 关闭(退回纯效能序)。
 *  尾配对 = 该元素配对里 pairId 不含合并对任一张的条目 = 合并剪枝后剩下的
 *  部分;尾均步大 = 合并后元素残余负担重。对照:temp/v3check_pre_tailw
 *  (布尔过滤版)与 temp/v3check(本版,w=1)同盘对照 */
export const TAIL_STEP_WEIGHT = 0.3; // 消融(2026-11-27,各 150 局,对布尔过滤基线):0.3 与 1 同为 14 元素 85.3%(+1 局零反例)、23 元素持平——0.3 改变选牌更少(58/150 vs 48/150 一致),取更轻的工作点

/** 尾配对平均步数(感知域:只读当前报告):该元素配对里,pairId 不含 pairTiles
 *  任一张的条目(= 合并剪枝后剩下的尾配对),其 pairPicks 的平均值;无尾配对 → 0 */
const tailAvgSteps = (matches: MatchReport, elementId: string, pairTiles: readonly [number, number]): number => {
  const ms = matches.byElement.get(elementId) ?? [];
  const tail = ms.filter(m => m.pairId[0] !== pairTiles[0] && m.pairId[0] !== pairTiles[1]
    && m.pairId[1] !== pairTiles[0] && m.pairId[1] !== pairTiles[1]);
  if (tail.length === 0) return 0;
  return tail.reduce((s2, m) => s2 + m.cost.pairPicks, 0) / tail.length;
};

/** 感知域规则(2026-11-26 设计者):偶数优先——元素的已感知张数(含槽内)为偶,
 *  剩下的牌都能在感知域内两两配掉;为奇则必有一张要等隐藏的伴(总张数恒为偶)。
 *  有偶数候选时只在偶数里选,没有才回退全部候选 */
const preferEvenParity = (tileIds: ReadonlyArray<number>, ctx: LadderContext): ReadonlyArray<number> => {
  const countOf = (elementId: string): number => {
    let c = 0;
    for (const s of ctx.view.slot) if (s.elementId === elementId) c++;
    for (const p of ctx.view.perceived) if (p.elementId === elementId) c++;
    return c;
  };
  const elementOf = (t: number): string | undefined =>
    ctx.view.perceived.find(x => x.tileId === t)?.elementId
    ?? ctx.view.slot.find(x => x.tileId === t)?.elementId;
  const even = tileIds.filter(t => {
    const el = elementOf(t);
    return el !== undefined && countOf(el) % 2 === 0;
  });
  return even.length > 0 ? even : tileIds;
};

/** 梯 1 slot-close:闭合槽内半张——优先闭合,防半张占槽。
 *  候选来源 = MatchReport 中全部 close 型配对的目标牌(2026-11-24 配对保留扩展后,
 *  槽内一张牌可能有多张可点的伴)。**按牌去重**:同一张牌每次决策只算一次效能。
 *  行为边界不变:只处理立即可闭合的;槽内持伴但伴被压属 hold 型,归后续梯。
 *  择优 = 推进效能最大者(2026-11-25 设计者设计,见 advanceOf);平分取 tileId 小者。
 *  所拿的牌若同时在某条 hold / dig 的路径上,才有效能;否则为 0,由 tileId 决胜。
 *  **感知域规则一(2026-11-27 设计者,取代布尔版尾配对过滤)**:偶数优先 +
 *  尾均步加权——排序值 = 推进效能 / (1 + TAIL_STEP_WEIGHT × 尾配对平均
 *  pairPicks);尾配对 = 该元素配对里 pairId 不含本对任一张的条目,其平均
 *  pairPicks = 合并后元素的残余负担。归因背景:可解盘的致死合并手 10 例,
 *  闭对时机会平移元素的开对窗(seed 1107 步 13 为实证反例),布尔版对已
 *  观察致死手零覆盖——连续权重是对该类失误的量化尝试(对照结果见
 *  关卡生成节点 未决参数 第 20/21 条)。
 *  **感知域规则二(2026-11-26 设计者)**:偶数优先,见 preferEvenParity */
export const slotCloseRung: DecisionRung = {
  rule: 'slot-close',
  decide(ctx) {
    const closes = ctx.analysis.matches.opportunities.filter(
      o => o.type === 'close' && o.launcher.inSlot);
    // 尾配对可执行(SLOT_CLOSE_YIELD 让位检查用,见下方让位块)
    const tailExec = (o: MatchOpportunity): boolean => {
      const ms = ctx.analysis.matches.byElement.get(o.elementId) ?? [];
      const l = o.launcher.tileId, g = o.target.tileId;
      return ms.some(m => {
        const hasL = m.pairId[0] === l || m.pairId[1] === l;
        const hasG = m.pairId[0] === g || m.pairId[1] === g;
        return !hasL && !hasG && m.executable === true;
      });
    };
    let cands = closes;
    if (SLOT_CLOSE_YIELD) {
      cands = cands.filter(o => {
        if (tailExec(o)) return true;                       // 尾配对可执行:闭得值
        const l = o.launcher.tileId;
        const ms = ctx.analysis.matches.byElement.get(o.elementId) ?? [];
        return !ms.some(m => {
          if (m.type !== 'hold' || m.executable !== true) return false;
          const hasL = m.pairId[0] === l || m.pairId[1] === l;
          if (!hasL) return false;
          const mate = m.pairId[0] === l ? m.pairId[1] : m.pairId[0];
          const ms2 = ms.filter(x => {
            const hL = x.pairId[0] === l || x.pairId[1] === l;
            const hM = x.pairId[0] === mate || x.pairId[1] === mate;
            return !hL && !hM;
          });
          return ms2.some(x => x.executable === true);      // hold 路线的尾配对可执行
        });
      });
    }
    // 候选 = 目标牌,去重后按 tileId 升序
    const targetIds = [...new Set(cands.map(o => o.target.tileId))].sort((a, b) => a - b);
    if (targetIds.length === 0) return null;

    // 感知域规则(2026-11-27 设计者,取代布尔版尾配对过滤):偶数优先 + 尾均步
    // 加权——排序值 = 推进效能 / (1 + TAIL_STEP_WEIGHT × 尾配对平均 pairPicks)。
    // 尾配对 = 该元素配对里 pairId 不含本对任一张的条目 = 合并剪枝后剩下的部分;
    // 尾均步大 = 合并后元素残余负担重。平分取 tileId 小者
    let bestT = -1, bestV = -1, runnerT = -1, runnerV = -1;
    for (const t of preferEvenParity(targetIds, ctx)) {
      const o = cands.find(x => x.target.tileId === t)!;
      const avgTail = tailAvgSteps(ctx.analysis.matches, o.elementId,
        [o.launcher.tileId, o.target.tileId]);
      const v = advanceOf(t, ctx).total / (1 + TAIL_STEP_WEIGHT * avgTail);
      if (v > bestV) { runnerT = bestT; runnerV = bestV; bestT = t; bestV = v; }
      else if (v > runnerV) { runnerT = t; runnerV = v; }
    }
    const match = cands.find(o => o.target.tileId === bestT)!;
    const advance = advanceOf(bestT, ctx);
    return {
      action: { type: 'pick', tileId: bestT },
      reason: {
        rule: this.rule,
        note: `闭合槽内 tileId ${match.launcher.tileId}`
          + ` · ${advanceNote(advance)}`
          + (runnerT >= 0 ? ` · 次优 ${runnerT}(${advanceNote(advanceOf(runnerT, ctx))})` : '')
          + ` · 消耗 ${match.matchCost}/${ctx.analysis.matches.emptySlots} 格`
          + ` · 候选 ${targetIds.length}`
          + ` · 尾均步 ${tailAvgSteps(ctx.analysis.matches, match.elementId, [match.launcher.tileId, match.target.tileId]).toFixed(1)}`,
        utility: advance.total,
        runnerUp: runnerT >= 0 ? { tileId: runnerT, score: advanceOf(runnerT, ctx).total } : undefined,
        advance,
      },
      expectation: expectForPick(bestT, ctx, 'certain'),
    };
  },
};

/** 梯 2 pair-complete:双亮对(P2 折叠)——拿可执行 double 型匹配中的一张。
 *  候选来源 = MatchReport 中**可执行**的 double 型配对里的牌(2026-11-24 配对保留
 *  扩展后,同元素可点的牌两两成对)。可执行即峰值 ≤ 空槽:double 的峰值为 2,故空槽 < 2
 *  时整梯让位——不拿一张闭不了的半张去占最后的空槽。
 *  与 slot-close 的最大不同:一个匹配有**两张**可点的牌(launcher 与 target),拿哪张
 *  都能成对。**按牌去重**:每张候选牌只算一次推进效能,一并参与择优。
 *  择优 = 推进效能最大者(2026-11-25 设计者设计,见 advanceOf);平分取 tileId 小者。
 *  double 自己不产生效能(直接可配不计);效能来自这张牌所在的 hold / dig 路径 */
export const pairCompleteRung: DecisionRung = {
  rule: 'pair-complete',
  decide(ctx) {
    const matches = ctx.analysis.matches.opportunities.filter(
      o => o.type === 'double' && o.executable === true);
    if (matches.length === 0) return null;

    // 候选 = 这些配对里的牌,去重后按 tileId 升序
    const tileSet = new Set<number>();
    for (const m of matches) {
      tileSet.add(m.launcher.tileId);
      tileSet.add(m.target.tileId);
    }
    const tileIds = [...tileSet].sort((a, b) => a - b);

    const { tileId, advance, runnerUp } = pickBestByAdvance(preferEvenParity(tileIds, ctx), ctx)!;
    // 与所拿这张成对的那些可点伴
    const mateSet = new Set<number>();
    let elementId = '';
    let matchCost = 0;
    for (const m of matches) {
      if (m.launcher.tileId === tileId) {
        mateSet.add(m.target.tileId); elementId = m.elementId; matchCost = m.matchCost;
      } else if (m.target.tileId === tileId) {
        mateSet.add(m.launcher.tileId); elementId = m.elementId; matchCost = m.matchCost;
      }
    }
    const mates = [...mateSet].sort((a, b) => a - b);
    return {
      action: { type: 'pick', tileId },
      reason: {
        rule: this.rule,
        note: `双亮对 ${elementId}:持 tileId ${tileId}(伴 ${mates.join('/')} 可点,P2 折叠)`
          + ` · ${advanceNote(advance)}`
          + (runnerUp ? ` · 次优 ${runnerUp.tileId}(${advanceNote(runnerUp.advance)})` : '')
          + ` · 消耗 ${matchCost}/${ctx.analysis.matches.emptySlots} 格`
          + ` · 候选 ${tileIds.length}`,
        utility: advance.total,
        runnerUp: runnerUp ? { tileId: runnerUp.tileId, score: runnerUp.advance.total } : undefined,
        advance,
      },
      expectation: expectForPick(tileId, ctx),
    };
  },
};

/** 按 elementId 升序(排序的决胜键;相等返回 0,交给后面的 tileId 决胜) */
function byElementId(a: MatchOpportunity, b: MatchOpportunity): number {
  return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0;
}

/** ⛔ dig 候选的旧排序比较(2026-11-24 定稿、2026-11-25 停用):可执行 → 槽内遗留最少
 *  → 首牌拾取差分最优 → 首牌 tileId → elementId → 启动牌 → 目标牌。负数 = a 先。
 *  默认梯已改用推进效能(见 advanceOf / selectDig);本函数保留为对照基线,
 *  不再参与任何默认梯的择优 */
export function compareDigMatch(
  a: MatchOpportunity,
  b: MatchOpportunity,
  deltaOf: (m: MatchOpportunity) => PickDelta,
): number {
  return (b.executable === true ? 1 : 0) - (a.executable === true ? 1 : 0)
    || a.cost.residual.length - b.cost.residual.length
    || comparePickDelta(deltaOf(b), deltaOf(a))
    || a.cost.picks[0] - b.cost.picks[0]
    || byElementId(a, b)
    || a.launcher.tileId - b.launcher.tileId
    || a.target.tileId - b.target.tileId;
}

/** dig 梯的择优结果 */
export interface DigSelection {
  match: MatchOpportunity | null;
  /** 该决策的 hold / dig 清单事实(报告里有 hold / dig 配对时必有) */
  scan?: DigScanTrace;
  /** 所选首牌的推进效能(随操作落盘) */
  advance?: PickAdvance;
  /** 次优候选(首牌 tileId 与其效能;犹豫度原料) */
  runnerUp?: { tileId: number; advance: PickAdvance };
}

/** dig 梯的候选选择与择优:报告里的全部 hold / dig 型配对(报告期已逐条验算
 *  消耗与滞留牌),筛出可执行(峰值 ≤ 空槽、有拿牌计划)的,在**各条的首牌**上比
 *  推进效能,取最大者(2026-11-25 设计者设计,见 advanceOf;平分取首牌 tileId 小者)。
 *  同一张牌是多条配对的首牌时只算一次。
 *  原三级字典序(可执行 → 遗留最少 → 首牌差分,见 compareDigMatch)不再使用——
 *  可执行性已是效能的 0.1 系数、滞留已在效能的分母里,再单列成排序键是重复。
 *  无可执行 → match = null(让位,explore 接手)。close 型归 slot-close,double 型
 *  归 pair-complete。清单事实记入 scan(随操作落盘)。 */
export function selectDig(ctx: LadderContext): DigSelection {
  const report = ctx.analysis.matches;
  const todo = report.opportunities.filter(o => o.type === 'hold' || o.type === 'dig');
  if (todo.length === 0) return { match: null };

  const cands = todo.filter(o => o.executable === true && o.cost.picks.length > 0);
  const scan: DigScanTrace = {
    pairs: todo.length,
    executable: cands.length,
    elements: new Set(todo.map(o => o.elementId)).size,
  };
  if (cands.length === 0) return { match: null, scan };

  // ⛔ 实验开关(默认关;2026-11-26 设计者批准对照):短路线优先——dig 致死手
  //  18 例的共同特征是「低槽压时启动长路线」(pairPicks 均值 6.3 对健康 4.9,
  //  残留 1.5 对 0.97,零裕量 16/18;18/18 致命牌在见证中更晚出现 = 拿早了)。
  //  开启后候选先收窄到 pairPicks 最小的组,效能只在组内比较
  let pool = cands;
  if (DIG_SHORT_FIRST) {
    const minPP = Math.min(...cands.map(o => o.cost.pairPicks));
    pool = cands.filter(o => o.cost.pairPicks === minPP);
  }

  // 候选 = 各条的首牌(按牌去重);效能最大者,平分取首牌 tileId 小者
  const firstIds = [...new Set(pool.map(o => o.cost.picks[0]))].sort((a, b) => a - b);
  const picked = pickBestByAdvance(firstIds, ctx)!;
  // 所选首牌可能是多条配对的首牌:取其中「配对完成所需拿牌数」最少的那条作代表
  // (pairPicks 升序 → pairId 升序,确定性)
  const m = pool.filter(o => o.cost.picks[0] === picked.tileId).sort((a, b) =>
    a.cost.pairPicks - b.cost.pairPicks
    || byElementId(a, b)
    || a.launcher.tileId - b.launcher.tileId
    || a.target.tileId - b.target.tileId)[0];
  return {
    match: m,
    scan,
    advance: picked.advance,
    runnerUp: picked.runnerUp,
  };
}

/** dig 梯所选中的匹配(或 null = 让位);只取匹配本身时用这个 */
export function selectDigMatch(ctx: LadderContext): MatchOpportunity | null {
  return selectDig(ctx).match;
}

/** 梯 3 dig:启动一个需要挖掘的匹配。
 *  候选 = 报告里可执行的 hold / dig 型配对(报告期已逐条验算)的**首牌**;
 *  择优 = 首牌推进效能最大者(2026-11-25);无可执行 → 让位(explore 接手)。
 *  动作 = 所选匹配消除模拟计划的**第一次拾取**(MatchCostBreakdown.picks)——
 *  可执行性正是针对这套拿牌顺序得出的,照此执行才能兑现「峰值 ≤ 空槽」。
 *  2026-11-24 取代原 chain 梯:借槽两步闭合的两类机会在此均为可执行的
 *  hold 型匹配(峰值 2),由本梯覆盖。
 *  2026-11-25 起候选来源按设计者的报告/验算分工定稿(取代「报告期每元素验算一条 +
 *  出手时按需全量重枚举」的过渡方案);择优改为在首牌上比推进效能。 */
export const digRung: DecisionRung = {
  rule: 'dig',
  decide(ctx) {
    const { match: m, scan, advance, runnerUp } = selectDig(ctx);
    if (!m) return null;
    const tileId = m.cost.picks[0];
    return {
      action: { type: 'pick', tileId },
      reason: {
        rule: 'dig',
        note: `启动匹配 ${m.elementId}(${m.type}):拿 tileId ${tileId}`
          + ` · 消耗 ${m.matchCost}/${ctx.analysis.matches.emptySlots} 格`
          + ` · 到配对完成 ${m.cost.pairPicks} 拿`
          + (scan ? ` · 候选 ${scan.executable}/${scan.pairs} 对` : '')
          + (advance ? ` · ${advanceNote(advance)}` : '')
          + (runnerUp ? ` · 次优首牌 ${runnerUp.tileId}(${advanceNote(runnerUp.advance)})` : ''),
        match: {
          elementId: m.elementId, type: m.type,
          launcher: m.launcher.tileId, target: m.target.tileId,
          matchCost: m.matchCost!,
        },
        scan,
        advance,
        utility: advance ? advance.total : undefined,
        runnerUp: runnerUp ? { tileId: runnerUp.tileId, score: runnerUp.advance.total } : undefined,
      },
      expectation: expectForPick(tileId, ctx),
    };
  },
};

/** 梯 4 explore:寻找新的潜在可能性(2026-11-24 设计裁定)。
 *  接手时盘上已无任何可执行的匹配:空槽通常只剩 1~2 格,可点的牌没有一张能
 *  立刻缩小槽位占用。既然这一拿缩不了占用,就让它**尽可能多地买信息**——
 *  揭示预演只在当前感知集上进行,新露出的牌进入感知后,下一轮分析才可能
 *  出现新的可执行匹配。
 *  候选 = 全部主观可点牌。择优 = 字典序:**揭露量 > 自身风险**;平分取 tileId 小者。
 *   · 揭露量 = 揭示预演的 Σ激活值(closes 1.0 / pairs 0.8 / lone 0.2)——拿走这张
 *     后其直接覆盖的牌里有多少变可点、能否配对(揭示预演报告现成的 activationSum)
 *   · 自身风险 = 拿的这张入槽后,其伴是否主观可见(已识别且在感知集或槽内):
 *     可见 = 低风险(这张半张等得到伴);不可见 / 身份未识别 = 高风险
 *  「可能命中槽内半张」的推断未采用(设计者裁定,2026-11-24)。
 *  仅此一梯:空槽 1 时的必败局面不单独处理(届时任何拿法都是最后一步,
 *  同一评分退化为只看揭露量)。 */
export const exploreRung: DecisionRung = {
  rule: 'explore',
  decide(ctx) {
    if (ctx.clickable.length === 0) return null;
    let best: { tile: Tile; reveal: number; risky: number } | null = null;
    for (const t of ctx.clickable) {
      const forecast = simulateReveal(t.tileId, ctx.view, ctx.analysis);
      const c = {
        tile: t,
        reveal: forecast.activationSum,
        risky: exploreSelfRisk(t.tileId, ctx),
      };
      if (!best
          || c.reveal > best.reveal
          || (c.reveal === best.reveal && c.risky < best.risky)
          || (c.reveal === best.reveal && c.risky === best.risky && c.tile.tileId < best.tile.tileId)) {
        best = c;
      }
    }
    return {
      action: { type: 'pick', tileId: best!.tile.tileId },
      reason: {
        rule: this.rule,
        note: `探索:拿 tileId ${best!.tile.tileId}`
          + ` · 揭露 ${best!.reveal.toFixed(1)} · 自身${best!.risky === 0 ? '低风险(伴可见)' : '高风险(伴不可见)'}`,
      },
      expectation: expectForPick(best!.tile.tileId, ctx),
    };
  },
};

/** explore 的自身风险:所拿的牌入槽后其伴是否主观可见(0 = 可见,低风险;1 = 不可见)。
 *  伴可见 ⇔ 身份已识别,且同元素在槽内或感知集里还有别的牌 */
function exploreSelfRisk(tileId: number, ctx: LadderContext): number {
  const t = ctx.view.perceived.find(p => p.tileId === tileId);
  if (!t || t.elementId === UNKNOWN_ELEMENT) return 1;
  const g = ctx.analysis.groups.groups.get(t.elementId);
  if (!g) return 1;
  const others = g.slot.length + g.pile.filter(r => r.tileId !== tileId).length;
  return others > 0 ? 0 : 1;
}

/** wander:均匀随机(骨架级)。**不再是默认梯的一员**——2026-11-24 起由 explore
 *  取代;保留作随机对照基线(实验时替换末梯即可) */
export const wanderRung: DecisionRung = {
  rule: 'wander',
  decide(ctx) {
    return randomPickOp('wander', ctx);
  },
};

/** 休闲基线梯(顺序 = 优先级;增删换序即插拔) */
export const defaultLadder: ReadonlyArray<DecisionRung> = [
  slotCloseRung,
  pairCompleteRung,
  digRung,
  exploreRung,
];

// ─────────────────────────── 瀑布执行 ───────────────────────────

/**
 * 瀑布:依序过梯,首个非空胜出;全空 → 内置 fallback(均匀随机安全网,
 * 正常配梯后罕触发——explore 梯只要有可点牌就会出手,它只接住「无可点牌」
 * 与「梯配错了」的情况)。
 */
export function decideByLadder(
  rungs: ReadonlyArray<DecisionRung>,
  ctx: LadderContext,
): AgentOperation {
  for (const rung of rungs) {
    const op = rung.decide(ctx);
    if (op) return op;
  }
  return randomPickOp('fallback', ctx);
}

/** 桥接:梯 → Runner 的 decision 策略 */
export function ladderPolicy(rungs: ReadonlyArray<DecisionRung> = defaultLadder): DecisionPolicy {
  return ctx => decideByLadder(rungs, ctx);
}
