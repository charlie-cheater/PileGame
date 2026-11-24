// ============================================================================
// Runner.ts — 仿真玩家代理 · 执行循环(①感知 → ②分析 → ③决策 → ④操作)
//
// 决策两轨(2026-11-23 骨架期并存):
//   · policy(legacy):返回 tileId 的策略(randomPolicy / greedyPairPolicy,
//     批量统计基线的可重放行为不变)
//   · decision(v2,优先):产出 Operation(动作+原因+预期)的决策策略,
//     见 Ladder.ts 扫描梯瀑布;expectation 即 ⑤预期的对账面,随轨迹落盘
//
// 每步留存感知/分析摘要(轨迹数据):后续难度感知与规划器反馈的原料。
// 注意:runAgent 直接驱动 Board(会消耗牌堆)——重复实验须每次新建 Board。
// ============================================================================

import { Board } from '../core/Board';
import { Tile } from '../core/tile';
import { lcg } from '../core/LevelBuilder';
import { perceive, SubjectiveView, UNKNOWN_ELEMENT } from './Perception';
import { analyze, AnalysisResult } from './Analysis';
import { AgentOperation, DecisionPolicy, LadderContext, OperationTrace } from './Ladder';

/** 决策策略:从主观可点集中选一张,返回 tileId */
export type AgentPolicy = (ctx: {
  view: SubjectiveView;
  analysis: AnalysisResult;
  /** 主观可点牌(已按分析过滤;elementId 可能被遮蔽) */
  clickable: ReadonlyArray<Tile>;
  rng: () => number;
}) => number;

/** v1 默认策略:均匀随机(可解性语料生成的对照基线) */
export const randomPolicy: AgentPolicy = ctx => {
  const i = Math.floor(ctx.rng() * ctx.clickable.length);
  return ctx.clickable[Math.min(i, ctx.clickable.length - 1)].tileId;
};

/** 对照策略:见对先拿——优先取能闭合槽内对的牌;仅凭主观识别(elementId
 *  已遮蔽的 '?' 牌不参与闭合判定,尊重感知边界);无对可闭时随机。 */
export const greedyPairPolicy: AgentPolicy = ctx => {
  const slotElems = new Set(ctx.view.slot.map(s => s.elementId));
  const completing = ctx.clickable.filter(c => slotElems.has(c.elementId));
  const pool = completing.length > 0 ? completing : ctx.clickable;
  const i = Math.floor(ctx.rng() * pool.length);
  return pool[Math.min(i, pool.length - 1)].tileId;
};

/** 单步轨迹(感知/分析摘要 + 决策与结果) */
export interface StepRecord {
  step: number;
  /** ①感知摘要(该步决策前的视图) */
  perceived: number;
  hidden: number;
  maskedIdentity: number;
  clickable: number;
  /** ③④决策与操作 */
  chosenTile: number;
  /** 代理所知的所选牌身份(未识别 = UNKNOWN_ELEMENT) */
  chosenElement: string;
  /** 该次拾取是否触发配对消除 */
  paired: boolean;
  slotAfter: number;
  /** v2 决策轨:操作摘要(动作略去——chosenTile 即动作;legacy 路径为空) */
  operation?: OperationTrace;
}

export interface RunReport {
  outcome: 'cleared' | 'slot_full' | 'no_clickable';
  steps: ReadonlyArray<StepRecord>;
  picks: number;
  pairsEliminated: number;
  /** 过程中槽内牌数峰值(1~4;张力原料) */
  maxSlotPressure: number;
  /** 全程主观可点性冲突累计(v3 等价定理,期望恒 0) */
  clickConflicts: number;
}

export interface AgentParams {
  /** 随机种子(缺省非确定;同 seed + 同 Board 逐字节可重放) */
  seed?: number;
  /** 决策策略(缺省 randomPolicy) */
  policy?: AgentPolicy;
  /** v2 决策策略(产出 Operation;优先于 policy) */
  decision?: DecisionPolicy;
  identifyThreshold?: number;
  /** 拾取次数安全上限(缺省 = 总牌数 + 4) */
  maxPicks?: number;
}

/** 运行代理直至终局(清空 / 槽满判负 / 无可点) */
export function runAgent(board: Board, params: AgentParams = {}): RunReport {
  const rng = params.seed !== undefined ? lcg(params.seed) : Math.random;
  const policy = params.policy ?? randomPolicy;
  const steps: StepRecord[] = [];
  let pickCount = 0;
  let pairsEliminated = 0;
  let maxSlotPressure = 0;
  let clickConflicts = 0;
  const maxPicks = params.maxPicks ?? board.allTiles().length + 4;

  const finish = (outcome: RunReport['outcome']): RunReport =>
    ({ outcome, steps, picks: pickCount, pairsEliminated, maxSlotPressure, clickConflicts });

  while (pickCount < maxPicks) {
    if (board.isCleared()) return finish('cleared');

    // ①感知 → ②分析(分析结果保持纯主观,不接收真值)
    const view = perceive(board, { identifyThreshold: params.identifyThreshold });
    const analysis = analyze(view);
    // 可点性对账在驱动侧做:主观 clickable 对真值(v3 等价定理,期望恒 0)
    for (const t of view.perceived) {
      if (analysis.derived.get(t.tileId)?.clickable !== board.getDerived(t.tileId)?.clickable) {
        clickConflicts++;
      }
    }

    const clickable = view.perceived
      .filter(t => analysis.derived.get(t.tileId)?.clickable === true);
    if (clickable.length === 0) return finish('no_clickable');

    // ③决策:decision(v2,Operation)优先 → 否则 legacy policy(tileId)
    const ctx: LadderContext = { view, analysis, clickable, rng };
    let operation: AgentOperation | null = null;
    let tileId: number;
    if (params.decision) {
      operation = params.decision(ctx);
      tileId = operation.action.tileId;
    } else {
      tileId = policy(ctx);
    }
    // 防御:选牌须在主观可点集内,否则回退首张(决策策略可信,护栏常在)
    const chosen = clickable.find(t => t.tileId === tileId) ?? clickable[0];
    const r = board.pick(chosen.tileId);
    pickCount++;
    if (!r.ok) return finish('no_clickable');   // 理论不可达(主观可点 = 真值,v3)

    if (r.paired) {
      board.eliminate(r.paired[0], r.paired[1]);
      board.compactSlots();
      pairsEliminated++;
    }
    maxSlotPressure = Math.max(maxSlotPressure, board.slotCount());

    steps.push({
      step: steps.length + 1,
      perceived: view.perceived.length,
      hidden: view.totalPileCount - view.perceived.length,
      maskedIdentity: view.perceived.filter(t => t.elementId === UNKNOWN_ELEMENT).length,
      clickable: clickable.length,
      chosenTile: tileId,
      chosenElement: chosen.elementId,
      paired: !!r.paired,
      slotAfter: board.slotCount(),
      operation: operation
        ? { rule: operation.reason.rule, note: operation.reason.note,
            utility: operation.reason.utility, runnerUp: operation.reason.runnerUp,
            delta: operation.reason.delta, match: operation.reason.match,
            expectation: operation.expectation }
        : undefined,
    });

    if (board.isSlotFull() && !board.findSlotPair()) return finish('slot_full');
  }
  return finish('slot_full');   // 上限兜底(每步 pile 严格递减,理论不可达)
}
