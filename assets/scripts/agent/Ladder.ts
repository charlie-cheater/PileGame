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
//   判负;slot-close 先行则逐对闭合清盘。tests/agent-decision.test.js
//   以逆序梯实证此裁定。
//
// 梯序(休闲基线 defaultLadder):slot-close → pair-complete → chain → wander
//   (cheap-hold / dig / forced 待实现)。chain 居 pair-complete 之后:闭对的
//   每一步都看得见,只比双亮对多一步(2026-11-23 裁定)。
//
// 人类可信度边界:单遍扫描不回溯;梯内效用 = 分析数据一跳可达
//   (效用打分属 Step 2);expectation 只预测「下一步感知可验证」的字段。
// ============================================================================

import { Tile } from '../core/tile';
import { SLOT_COUNT } from '../core/Board';
import { SubjectiveView, UNKNOWN_ELEMENT } from './Perception';
import { AnalysisResult, ChainKind, IdentifiedTileRecord, RevealForecast, simulateReveal } from './Analysis';

// ─────────────────────────── 契约类型 ───────────────────────────

/** 思考模式(扫描梯的梯名;fallback = 内置安全网,非可插拔梯) */
export type DecisionRule =
  | 'slot-close'     // 闭合槽内半张
  | 'pair-complete'  // 双亮对折叠(P2)
  | 'chain'          // 借槽两步闭合(slot / pair 两类)
  | 'cheap-hold'     // 持半(Step 2)
  | 'dig'            // 挖掘(Step 2)
  | 'forced'         // 被迫(Step 2)
  | 'wander'         // 无信号显著度随机
  | 'fallback';      // 内置兜底

/** 借槽两步闭合的一条链路(③→⑤ 对账面:下一步拿 tileId 即应闭对) */
export interface ChainLink {
  /** 揭出后下一步拿走即可闭对的牌 */
  tileId: number;
  /** 与谁闭合:slot = 槽内已有的半张;pair = 本次拿的这张 */
  kind: ChainKind;
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
  /** chain 梯专用:本次拿牌揭出、下一步即可闭对的牌及其分类(可多条) */
  chain?: ChainLink[];
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
  chain?: ChainLink[];
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

// ─────────────────────────── 梯内平级择优(效能打分) ───────────────────────────

/**
 * 同梯多候选择优(2026-11-23 用户指示):用分析数据为每个候选构建效能,
 * 取最大;平分取 tileId 较小者(确定性,不耗 rng)。
 *
 * 效能 = 揭示预演(simulateReveal)的两路求和,2026-11-23 裁定口径:
 *   · activation(高权重 0.7):预演后变可点的直接目标,逐张计激活值
 *     closes 1.0(伴在槽)/ pairs 0.8(另有已识别牌同批或当前可点)/ lone 0.2
 *     ——**求和不归一**:揭 3 张优势牌好过 2 张(布局规则下单次揭露 ≤ 4 张)
 *   · near(低权重 0.3):预演后仍被压的直接目标里,「剩余遮挡者有可点牌」
 *     (再拿一张即可点)的张数——轮次口径,与激活值同为求和
 *   · 权重只比值有意义:一张优势牌 ≈ 2.3 张「再拿一张就可点」的被压牌
 *
 * 已移除项(口径不干净或设计意图待定):
 *   · revealArea / depthGain —— 像素口径的量回答轮次口径的问题;由预演替代
 *   · hardness —— 设计意图待分析,暂不计分
 */
const EFF_WEIGHTS = { activation: 0.7, near: 0.3 } as const;

export interface PickEfficiency {
  /** Σ 激活值(closes 1.0 / pairs 0.8 / lone 0.2) */
  activationSum: number;
  /** near 张数 */
  nearCount: number;
  /** 加权总分 = 0.7·activationSum + 0.3·nearCount */
  score: number;
}

/** 预演报告 → 效能(两路求和;候选已持有 forecast 时直接调用,免重算) */
export function scoreOfForecast(f: RevealForecast): PickEfficiency {
  return {
    activationSum: f.activationSum,
    nearCount: f.nearCount,
    score: EFF_WEIGHTS.activation * f.activationSum + EFF_WEIGHTS.near * f.nearCount,
  };
}

/** 单个候选拾取的效能评估(揭示预演 → 加权求和) */
export function scorePick(tileId: number, ctx: LadderContext): PickEfficiency {
  return scoreOfForecast(simulateReveal(tileId, ctx.view, ctx.analysis));
}

/** 候选集内取效能最大者(平分取 id 小者;顺带记录次优供犹豫度) */
function pickBest<T>(
  candidates: ReadonlyArray<T>,
  idOf: (t: T) => number,
  score: (t: T) => PickEfficiency,
): { pick: T; eff: PickEfficiency; runnerUp?: { tileId: number; score: number } } {
  let best: T | null = null;
  let bestEff: PickEfficiency | null = null;
  let bestId = 0;
  let runnerUp: { tileId: number; score: number } | undefined;
  for (const c of candidates) {
    const e = score(c);
    const id = idOf(c);
    if (!best || e.score > bestEff!.score
        || (e.score === bestEff!.score && id < bestId)) {
      if (best) runnerUp = { tileId: bestId, score: bestEff!.score };
      best = c;
      bestEff = e;
      bestId = id;
    } else if (!runnerUp || e.score > runnerUp.score) {
      runnerUp = { tileId: id, score: e.score };
    }
  }
  return { pick: best!, eff: bestEff!, runnerUp };
}

// ─────────────────────────── 示范梯(休闲基线) ───────────────────────────

/** 梯 1 slot-close:槽内牌的可点伴——优先闭合,防半张占槽;多候选效能取最大 */
export const slotCloseRung: DecisionRung = {
  rule: 'slot-close',
  decide(ctx) {
    const candidates: Array<{ mate: Tile; slotTileId: number }> = [];
    for (const s of ctx.view.slot) {
      const mate = ctx.clickable.find(c => c.elementId === s.elementId);
      if (mate) candidates.push({ mate, slotTileId: s.tileId });
    }
    if (candidates.length === 0) return null;

    const { pick, eff, runnerUp } = pickBest(
      candidates,
      c => c.mate.tileId,
      c => scorePick(c.mate.tileId, ctx));
    const fmt = (n: number): string => n.toFixed(2);
    return {
      action: { type: 'pick', tileId: pick.mate.tileId },
      reason: {
        rule: this.rule,
        note: `闭合槽内 tileId ${pick.slotTileId} · 效能 ${fmt(eff.score)}`
          + `(激活 ${fmt(eff.activationSum)}/近点 ${eff.nearCount})`
          + (runnerUp ? ` · 次优 ${fmt(runnerUp.score)}` : ''),
        utility: eff.score,
        runnerUp,
      },
      expectation: expectForPick(pick.mate.tileId, ctx, 'certain'),
    };
  },
};

/** 梯 2 pair-complete:双亮对(P2 折叠);元素内选较优半张,跨元素效能取最大 */
export const pairCompleteRung: DecisionRung = {
  rule: 'pair-complete',
  decide(ctx) {
    let best: { mate: IdentifiedTileRecord; partner: number; eff: PickEfficiency;
                runnerUp?: { tileId: number; score: number } } | null = null;
    ctx.analysis.groups.groups.forEach(g => {
      const lit = g.pile.filter(r => r.clickable);
      if (lit.length < 2) return;
      // 元素内:两张同元素可互换,选预演效能较优的半张持走
      const inner = pickBest(lit, t => t.tileId, t => scorePick(t.tileId, ctx));
      const partner = lit.find(r => r.tileId !== inner.pick.tileId)!.tileId;
      if (!best) {
        best = { mate: inner.pick, partner, eff: inner.eff };
      } else if (inner.eff.score > best.eff.score
          || (inner.eff.score === best.eff.score && inner.pick.tileId < best.mate.tileId)) {
        best = { mate: inner.pick, partner, eff: inner.eff,
                 runnerUp: { tileId: best.mate.tileId, score: best.eff.score } };
      } else if (!best.runnerUp || inner.eff.score > best.runnerUp.score) {
        best.runnerUp = { tileId: inner.pick.tileId, score: inner.eff.score };
      }
    });
    if (!best) return null;

    const fmt = (n: number): string => n.toFixed(2);
    return {
      action: { type: 'pick', tileId: best.mate.tileId },
      reason: {
        rule: this.rule,
        note: `双亮对:持 tileId ${best.mate.tileId}(伴 ${best.partner} 可点,P2 折叠)`
          + ` · 效能 ${fmt(best.eff.score)}`
          + `(激活 ${fmt(best.eff.activationSum)}/近点 ${best.eff.nearCount})`
          + (best.runnerUp ? ` · 次优 ${fmt(best.runnerUp.score)}` : ''),
        utility: best.eff.score,
        runnerUp: best.runnerUp,
      },
      expectation: expectForPick(best.mate.tileId, ctx),
    };
  },
};

/** chain 梯的空槽门槛:本次拿的牌入槽占 1 格,揭出的伴再入 1 格才触发闭对 */
const CHAIN_MIN_EMPTY_SLOTS = 2;

/** chain 梯内 pair 类链路的加分(2026-11-23 用户裁定「槽位干净更重要」):
 *  pair 链闭对后两张一起离场,不新接手半张;slot 链则把槽里原来等的半张
 *  换成本次拿的这张(两步后槽内张数相同,手里等的那张换了)。加分表达
 *  「不愿接手新的半张」。取值 = near 权重 0.3(系统里既有的低权单位):
 *    一条 pair 链 = 1.0 —— 胜 slot 链多揭 1~2 张散牌(0.84 / 0.98),
 *    与 slot 链多 1 张近点(1.0)同分(按 tileId),
 *    不敌 slot 链多揭 1 张 pairs 牌(1.26)。
 *  按条计(一条 pair 链路加一次) */
const CHAIN_PAIR_BONUS = 0.3;

/** 梯 3 chain:借槽两步闭合——拿一张可点牌,它揭出的牌下一步拿走即可闭对。
 *  两类同梯、按效能取最大(2026-11-23 用户裁定):slot = 揭出的牌与槽内已有
 *  半张闭合;pair = 揭出的牌与本次拿的这张闭合(另计加分 CHAIN_PAIR_BONUS)。
 *  预演深度 2,不继续往下预演。
 *  可用性是开关而非打分项:空槽 < 2 时整梯让位(按当前容量计——槽位扩充
 *  道具下表达式不变,自动适应)。本梯假定 slot-close / pair-complete 已让位。 */
export const chainRung: DecisionRung = {
  rule: 'chain',
  decide(ctx) {
    if (SLOT_COUNT - ctx.view.slot.length < CHAIN_MIN_EMPTY_SLOTS) return null;
    const candidates: Array<{ tile: Tile; links: ChainLink[]; eff: PickEfficiency;
                             pairLinks: number }> = [];
    for (const t of ctx.clickable) {
      const f = simulateReveal(t.tileId, ctx.view, ctx.analysis);
      const links: ChainLink[] = [];
      for (const c of f.clickable) {
        if (c.chain !== null) links.push({ tileId: c.tileId, kind: c.chain });
      }
      if (links.length === 0) continue;
      const eff = scoreOfForecast(f);
      const pairLinks = links.filter(l => l.kind === 'pair').length;
      eff.score += CHAIN_PAIR_BONUS * pairLinks;
      candidates.push({ tile: t, links, eff, pairLinks });
    }
    if (candidates.length === 0) return null;

    const { pick, eff, runnerUp } = pickBest(
      candidates, c => c.tile.tileId, c => c.eff);
    const fmt = (n: number): string => n.toFixed(2);
    return {
      action: { type: 'pick', tileId: pick.tile.tileId },
      reason: {
        rule: this.rule,
        note: `借槽两步闭合:${pick.links.map(l => `${l.kind}→${l.tileId}`).join('、')}`
          + ` · 效能 ${fmt(eff.score)}(激活 ${fmt(eff.activationSum)}/近点 ${eff.nearCount}`
          + (pick.pairLinks > 0 ? `/pair 加分 ${fmt(CHAIN_PAIR_BONUS * pick.pairLinks)}` : '')
          + `)`
          + (runnerUp ? ` · 次优 ${fmt(runnerUp.score)}` : ''),
        utility: eff.score,
        runnerUp,
        chain: pick.links,
      },
      expectation: expectForPick(pick.tile.tileId, ctx),
    };
  },
};

/** 梯 4 wander:无任何配对信号时的随机(骨架级均匀;显著度加权待人格批) */
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
  chainRung,
  wanderRung,
];

// ─────────────────────────── 瀑布执行 ───────────────────────────

/**
 * 瀑布:依序过梯,首个非空胜出;全空 → 内置 fallback(均匀随机安全网,
 * 正常配梯后罕触发——wander 梯在位时它只接住「梯配错了」的情况)。
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
