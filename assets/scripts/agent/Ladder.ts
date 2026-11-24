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
//   四梯的候选来源统一为 MatchReport 的三类匹配 + 兜底:slot-close 收 close 型,
//   pair-complete 收可执行 double 型,dig 收其余可执行匹配(hold / dig 型),
//   explore 接手「无可执行匹配」的局面(不收匹配,按揭露量与自身风险选牌)。
//   wander(均匀随机)保留为对照基线,不在默认梯。
//   原 chain 梯(借槽两步闭合,2026-11-23)已于 2026-11-24 整体移除:其两类机会
//   在 MatchReport 中均为可执行的 hold 型匹配,由 dig 梯覆盖。
//
// 择优依据(2026-11-24 设计定论):梯内择优统一用「拾取差分」的字典序
//   (新增可执行匹配 > 类型升级 > 峰值下降总量);原揭示预演两路求和
//   (0.7 × Σ激活 + 0.3 × near)仅服务于 chain 梯,随其移除而退场。
//
// 人类可信度边界:单遍扫描不回溯;expectation 只预测「下一步感知可验证」的字段。
// ============================================================================

import { Tile } from '../core/tile';
import { SubjectiveView, UNKNOWN_ELEMENT } from './Perception';
import { analyze, AnalysisResult, MatchOpportunity, MatchType, RevealForecast, simulateReveal } from './Analysis';

// ─────────────────────────── 契约类型 ───────────────────────────

/** 思考模式(扫描梯的梯名;fallback = 内置安全网,非可插拔梯) */
export type DecisionRule =
  | 'slot-close'     // 闭合槽内半张(close 型匹配)
  | 'pair-complete'  // 双亮对折叠(P2;可执行 double 型匹配)
  | 'dig'            // 启动需挖掘的匹配(可执行 hold / dig 型匹配)
  | 'explore'        // 寻找新的潜在可能性(无可执行匹配时,按揭露量买信息)
  | 'wander'         // 均匀随机(对照基线,不在默认梯)
  | 'fallback';      // 内置兜底

/** dig 梯所选中的匹配(结构化引用,随操作落盘) */
export interface ChosenMatch {
  elementId: string;
  /** 匹配类型(hold / dig) */
  type: MatchType;
  /** 启动牌 */
  launcher: number;
  /** 目标牌 */
  target: number;
  /** 消耗 = 消除模拟的净占用峰值(槽位格数) */
  matchCost: number;
}

/** 一次拾取前后分析数据的差异(2026-11-24 设计定论:决策只产生「拾取一张牌」,
 *  故可预演拾取 → 对新盘面重新分析 → 比较差异 → 量化收益)。详见 pickDelta */
export interface PickDelta {
  /** 拾取后新出现的「可执行」匹配数(原来做不了、现在能做了) */
  newExecutable: number;
  /** 类型升级数:同一匹配 (launcher, target) 的可达性跃迁。
   *  含 新出现的 close / double 型,与 hold→double、dig→hold / double */
  upgrades: number;
  /** 保留匹配的峰值下降总量(同一匹配拾取前后的 matchCost 之差,只累计正值) */
  peakDrop: number;
  /** 诊断明细 */
  detail: {
    appeared: string[];      // 新出现的匹配(元素:类型)
    disappeared: string[];   // 消失的匹配(元素:类型)
    upgraded: string[];      // 类型升级(元素:旧→新)
    newExecIds: string[];    // 新增可执行的匹配(元素:类型)
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
  /** 拾取差分(2026-11-24 起,择优改用差分的梯随操作落盘;含三级分量与明细) */
  delta?: PickDelta;
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
  /** 拾取差分(择优改用差分的梯) */
  delta?: PickDelta;
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

/** 匹配的身份:同一配对在拾取前后用其两张牌标识。**与角色无关**——按 tileId
 *  升序记:launcher / target 互换仍是同一匹配(例:double 的 target 被拿走后
 *  入槽、成本变 0,在新一轮分析里成为 launcher)。若按 (launcher, target) 记,
 *  角色互换会被算成「消失一个 + 新出现一个」:同一对牌因拿的是哪一张而得到
 *  不同的差分(2026-11-24 改造 pair-complete 时发现并修正——该梯对同一匹配的
 *  两张牌各预演一次,身份必须与角色无关,比较才有意义) */
const matchKey = (o: MatchOpportunity): string => {
  const a = Math.min(o.launcher.tileId, o.target.tileId);
  const b = Math.max(o.launcher.tileId, o.target.tileId);
  return `${a}/${b}`;
};

/** 新出现的匹配里,属于 close / double 型(可直接闭合)的计入「升级」 */
function isNewlyCloseLike(o: MatchOpportunity): boolean {
  return o.type === 'close' || o.type === 'double';
}

/**
 * 拾取差分:预演拾取 tileId → 重新分析 → 与原分析比较。
 *
 * 预演范围(2026-11-24 设计裁定):**只在当前感知集上进行**——新露出的牌不进预演,
 * 操作落定后由下一轮 ①感知 → ②分析 纳入。预演是代理决策时的预期,不含尚未
 * 看见的牌;因此预演的收益是真实收益的下界(揭出越多越保守)。
 * 槽内状态变化纳入预演:拾取导致闭对则两张离场,后续匹配的可执行性按
 * **合并后的资源余量**判定(由 analyze 依新视图的 slot.length 自动得出)。
 * 纯函数:在视图的拷贝上模拟,不修改 ctx.view 与真实 Board(无需状态恢复)。
 */
export function pickDelta(tileId: number, ctx: LadderContext): PickDelta {
  const { view, analysis } = ctx;
  const after = simulateAnalysisAfterPick(tileId, ctx);
  const key = matchKey;
  const before = new Map(analysis.matches.opportunities.map(o => [key(o), o]));
  const afterMap = new Map(after.matches.opportunities.map(o => [key(o), o]));

  const appeared: MatchOpportunity[] = [];
  const disappeared: MatchOpportunity[] = [];
  const upgraded: Array<{ o: MatchOpportunity; from: MatchType }> = [];
  for (const o of afterMap.values()) {
    const b = before.get(key(o));
    if (!b) appeared.push(o);
    else if (b.type !== o.type) upgraded.push({ o, from: b.type });
  }
  for (const o of before.values()) {
    if (!afterMap.has(key(o))) disappeared.push(o);
  }

  // 新增可执行:拾取后可执行、且(新出现 或 原先不可执行)的匹配
  let newExecutable = 0;
  const newExecIds: string[] = [];
  for (const o of afterMap.values()) {
    if (!o.executable) continue;
    const b = before.get(key(o));
    if (!b || !b.executable) { newExecutable++; newExecIds.push(`${o.elementId}:${o.type}`); }
  }

  // 升级:保留匹配的可达性上升 + 新出现的 close / double
  let upgrades = 0;
  const upgradedNames: string[] = [];
  for (const u of upgraded) {
    if (REACH_RANK[u.o.type] > REACH_RANK[u.from]) { upgrades++; upgradedNames.push(`${u.o.elementId}:${u.from}→${u.o.type}`); }
  }
  for (const o of appeared) {
    if (isNewlyCloseLike(o)) { upgrades++; upgradedNames.push(`${o.elementId}:新${o.type}`); }
  }

  // 峰值下降总量:保留匹配的正向差值之和
  let peakDrop = 0;
  for (const o of afterMap.values()) {
    const b = before.get(key(o));
    if (!b) continue;
    const d = b.matchCost - o.matchCost;
    if (d > 0) peakDrop += d;
  }

  return {
    newExecutable, upgrades, peakDrop,
    detail: {
      appeared: appeared.map(o => `${o.elementId}:${o.type}`),
      disappeared: disappeared.map(o => `${o.elementId}:${o.type}`),
      upgraded: upgradedNames,
      newExecIds,
    },
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

/** 按拾取差分择优:字典序最大者;平分取 tileId 小者(确定性) */
function pickBestByDelta<T>(
  candidates: ReadonlyArray<T>,
  idOf: (t: T) => number,
  deltaOf: (t: T) => PickDelta,
): { pick: T; delta: PickDelta; runnerUp?: { tileId: number; delta: PickDelta } } {
  let best: T | null = null;
  let bestDelta: PickDelta | null = null;
  let bestId = 0;
  let runnerUp: { tileId: number; delta: PickDelta } | undefined;
  for (const c of candidates) {
    const d = deltaOf(c);
    const id = idOf(c);
    if (!best || comparePickDelta(d, bestDelta!) > 0
        || (comparePickDelta(d, bestDelta!) === 0 && id < bestId)) {
      if (best) runnerUp = { tileId: bestId, delta: bestDelta! };
      best = c;
      bestDelta = d;
      bestId = id;
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

// ─────────────────────────── 示范梯(休闲基线) ───────────────────────────

/** 梯 1 slot-close:闭合槽内半张——优先闭合,防半张占槽。
 *  候选来源 = MatchReport 中的 close 型匹配(launcher 在槽内、target 可点;
 *  2026-11-24 起,取代原先手扫「槽内牌 → 可点伴」——两者集合等价,但候选
 *  现在自带 matchCost / executable)。
 *  行为边界不变:只处理立即可闭合的;槽内持伴但伴被压属 hold 型,归后续梯。
 *  择优 = 拾取差分的字典序(2026-11-24 设计裁定):新增可执行匹配数 >
 *  类型升级数 > 保留匹配的峰值下降总量;平分取 tileId 小者。
 *  进槽成本不计——同梯内所有操作的进槽成本统一 */
export const slotCloseRung: DecisionRung = {
  rule: 'slot-close',
  decide(ctx) {
    const candidates: MatchOpportunity[] = ctx.analysis.matches.opportunities.filter(
      o => o.type === 'close' && o.launcher.inSlot);
    if (candidates.length === 0) return null;

    const { pick, delta, runnerUp } = pickBestByDelta(
      candidates,
      c => c.target.tileId,
      c => pickDelta(c.target.tileId, ctx));
    return {
      action: { type: 'pick', tileId: pick.target.tileId },
      reason: {
        rule: this.rule,
        note: `闭合槽内 tileId ${pick.launcher.tileId}`
          + ` · 差分 新增可执行 ${delta.newExecutable} / 升级 ${delta.upgrades} / 峰值降 ${delta.peakDrop}`
          + (runnerUp ? ` · 次优 ${runnerUp.tileId}(可执行 ${runnerUp.delta.newExecutable} / 升级 ${runnerUp.delta.upgrades} / 降 ${runnerUp.delta.peakDrop})` : '')
          + ` · 消耗 ${pick.matchCost}/${ctx.analysis.matches.emptySlots} 格`,
        utility: deltaScore(delta),
        runnerUp: runnerUp ? { tileId: runnerUp.tileId, score: deltaScore(runnerUp.delta) } : undefined,
        delta,
      },
      expectation: expectForPick(pick.target.tileId, ctx, 'certain'),
    };
  },
};

/** 梯 2 pair-complete:双亮对(P2 折叠)——拿可执行 double 型匹配中的一张。
 *  候选来源 = MatchReport 中**可执行**的 double 型匹配(2026-11-24 改造,流程同
 *  slot-close)。可执行即峰值 ≤ 空槽:double 的峰值为 2,故空槽 < 2 时整梯让位——
 *  不拿一张闭不了的半张去占最后的空槽。
 *  与 slot-close 的最大不同:每个匹配有**两张**可点的牌(launcher 与 target),
 *  拿哪张都能成对,但各自揭出的东西不同——故对两张牌**各做一次**拾取差分预演,
 *  一并参与择优。
 *  择优 = 拾取差分的字典序(同 slot-close):新增可执行匹配数 > 类型升级数 >
 *  保留匹配的峰值下降总量;平分取 tileId 小者。进槽成本不计 */
export const pairCompleteRung: DecisionRung = {
  rule: 'pair-complete',
  decide(ctx) {
    const matches = ctx.analysis.matches.opportunities.filter(
      o => o.type === 'double' && o.executable);
    if (matches.length === 0) return null;

    // 每个匹配的两张牌各预演一次
    const candidates: Array<{ match: MatchOpportunity; tileId: number }> = [];
    for (const m of matches) {
      candidates.push({ match: m, tileId: m.launcher.tileId });
      candidates.push({ match: m, tileId: m.target.tileId });
    }

    const { pick, delta, runnerUp } = pickBestByDelta(
      candidates, c => c.tileId, c => pickDelta(c.tileId, ctx));
    const other = pick.tileId === pick.match.launcher.tileId
      ? pick.match.target.tileId : pick.match.launcher.tileId;
    return {
      action: { type: 'pick', tileId: pick.tileId },
      reason: {
        rule: this.rule,
        note: `双亮对 ${pick.match.elementId}:持 tileId ${pick.tileId}(伴 ${other} 可点,P2 折叠)`
          + ` · 差分 新增可执行 ${delta.newExecutable} / 升级 ${delta.upgrades} / 峰值降 ${delta.peakDrop}`
          + (runnerUp ? ` · 次优 ${runnerUp.tileId}(可执行 ${runnerUp.delta.newExecutable} / 升级 ${runnerUp.delta.upgrades} / 降 ${runnerUp.delta.peakDrop})` : '')
          + ` · 消耗 ${pick.match.matchCost}/${ctx.analysis.matches.emptySlots} 格`,
        utility: deltaScore(delta),
        runnerUp: runnerUp ? { tileId: runnerUp.tileId, score: deltaScore(runnerUp.delta) } : undefined,
        delta,
      },
      expectation: expectForPick(pick.tileId, ctx),
    };
  },
};

/** dig 梯的候选选择:除 close / double 外的**可执行**匹配(即 hold / dig 型;
 *  可执行 = 峰值 ≤ 空槽数)。close 型归 slot-close,double 型归 pair-complete。
 *
 *  匹配间的排序(2026-11-24 定稿):槽内遗留最少 → 同遗留按消耗升序 → elementId。
 *  「遗留」= 该匹配消除模拟结束时卡在槽里的牌(`cost.residual`)——遗留少的匹配
 *  走完后盘面更干净。批量实证(各 100 局,同种子):14 元素档通关率 70%(对照
 *  占位消耗升序 63%、拾取差分 73%——差值在噪声边缘,且差分需对每个候选重新
 *  分析,不值),7 元素档峰值槽压 2.18(全场最低);23 / 35 元素档排序不敏感。 */
export function selectDigMatch(ctx: LadderContext): MatchOpportunity | null {
  const cands = ctx.analysis.matches.opportunities.filter(
    o => (o.type === 'hold' || o.type === 'dig') && o.executable && o.cost.picks.length > 0);
  if (cands.length === 0) return null;
  return cands.slice().sort((a, b) =>
    a.cost.residual.length - b.cost.residual.length
    || a.matchCost - b.matchCost
    || byElementId(a, b))[0];
}

/** 按 elementId 升序(排序的最终决胜键) */
function byElementId(a: MatchOpportunity, b: MatchOpportunity): number {
  return a.elementId < b.elementId ? -1 : 1;
}

/** 梯 3 dig:启动一个需要挖掘的匹配。
 *  候选 = selectDigMatch(可执行的 hold / dig 型)。
 *  动作 = 该匹配消除模拟计划的**第一次拾取**(MatchCostBreakdown.picks)。
 *  可执行性正是针对这套拿牌顺序得出的(先挖启动牌、再挖目标牌;能立即闭对
 *  的遮挡者优先),照此执行才能兑现「峰值 ≤ 空槽」。
 *  2026-11-24 取代原 chain 梯:借槽两步闭合的两类机会在此均为可执行的
 *  hold 型匹配(峰值 2),由本梯覆盖。 */
export const digRung: DecisionRung = {
  rule: 'dig',
  decide(ctx) {
    const m = selectDigMatch(ctx);
    if (!m) return null;
    const tileId = m.cost.picks[0];
    return {
      action: { type: 'pick', tileId },
      reason: {
        rule: this.rule,
        note: `启动匹配 ${m.elementId}(${m.type}):拿 tileId ${tileId}`
          + ` · 消耗 ${m.matchCost}/${ctx.analysis.matches.emptySlots} 格`
          + ` · 计划 ${m.cost.picks.length} 步`,
        match: {
          elementId: m.elementId, type: m.type,
          launcher: m.launcher.tileId, target: m.target.tileId,
          matchCost: m.matchCost,
        },
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
