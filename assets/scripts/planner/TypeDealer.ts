// ============================================================================
// TypeDealer.ts — 布局器:给定空间布局上的渐进式类型填充(边玩边发牌)
//
// 定位(2026-11-27 方向稿 v2,设计者确认):牌位(空间布局)事先给定、全程不变;
// 每张牌是什么图案,等玩家(仿真代理)看见它的那一刻才由布局器决定。
//   循环(经 Runner 的 Dealer 钩子):
//     ①感知 → 感知集 →【布局器】给新看见且未定型的牌定型 → 重新感知 → ②分析 → ③决策 → ④拿牌
//
// 必守事实(设计者裁定):
//   · 每种图案最终是偶数张。已定型的牌里张数为单数的图案「开着」(还差一张伴);
//     可行规则:未定型的牌数 U,任何时候都 ≥ 开着的图案数 O
//   · 见过的牌不变样:定型即冻结(由 Board.assignType 保证,与调用方无关)
//   · 没有配额约束:每种图案发几张不限(可以一种都不发),图案池由关卡定
//
// 本文件 = M0:完全随机发牌(池内等概率,只守奇偶)。松紧调节器(M2)与能通关检查(M1)
// 另加,不改本文件的接口。
// 布局器属生成侧:判断哪些牌未定型、记账都用 Board 全信息;它只给「感知集里」的牌定型,
// 代理的决策仍只读主观视图。
// ============================================================================

import { Board } from '../core/Board';
import { ElementDef, LevelData, TileVariant, Unit, isUnassigned, unassignedElementId } from '../core/tile';
import { OcclusionSubject } from '../core/Occlusion';
import { fisherYates, lcg, validateLevelData } from '../core/LevelBuilder';
import { SubjectiveView } from '../agent/Perception';
import { Dealer, runAgent, AgentParams, RunReport } from '../agent/Runner';
import { ladderPolicy } from '../agent/Ladder';

/** 空间布局骨架(与 RandomFill.fillSlots 同一形状):板面尺寸 + 牌位;不含类型 */
export interface LayoutSkeleton {
  board: { w: Unit; h: Unit };
  tiles: ReadonlyArray<OcclusionSubject>;
}

export interface DealerOptions {
  /** 图案池:这关允许哪几种图案(每种发几张不限) */
  pool: ElementDef[];
  /** 发牌随机种子(缺省非确定) */
  seed?: number;
}

export interface DealerStats {
  /** 定型事件次数(每次钩子调用且确有定型) */
  events: number;
  /** 开局批张数(第一次事件) */
  opening: number;
  /** 各批大小(时间序,含开局批) */
  readonly batches: number[];
  /** 全程最小余量 U − O(每定型一张之后取最小;≥ 0 = 可行规则全程未破) */
  minMargin: number;
  /** 局终收尾补定型的张数(只有死局会 > 0) */
  finished: number;
  /** 全程定型的张数(含收尾) */
  typed: number;
}

/** 奇偶账:每种图案已定型几张(牌堆 / 槽 / 已消都算)、开着的图案、未定型的牌数 */
interface Ledger {
  seen: Map<string, number>;
  open: string[];
  untyped: number;
}

export class TypeDealer implements Dealer {
  readonly stats: DealerStats = {
    events: 0, opening: 0, batches: [], minMargin: Number.POSITIVE_INFINITY, finished: 0, typed: 0,
  };
  private readonly pool: ElementDef[];
  private readonly poolIds: string[];
  private readonly rng: () => number;

  constructor(opts: DealerOptions) {
    if (opts.pool.length === 0) throw new Error('TypeDealer: 图案池为空');
    this.pool = opts.pool;
    this.poolIds = opts.pool.map(e => e.elementId);
    this.rng = opts.seed !== undefined ? lcg(opts.seed) : Math.random;
  }

  /** 每次钩子调用:给感知集里未定型的牌定型(按 tileId 升序逐张发),返回定型的张数。
   *  感知集里身份被遮蔽的牌(视图里是 '?')也在此定型——「进感知集即定型」。 */
  assign(board: Board, view: SubjectiveView): number {
    const led = this.ledger(board);
    let dealt = 0;
    for (const p of view.perceived) {
      const real = board.getTile(p.tileId);
      if (!real || !isUnassigned(real.elementId)) continue;   // 已定型的不碰
      const e = this.draw(led);
      board.assignType(p.tileId, e);
      led.seen.set(e, (led.seen.get(e) ?? 0) + 1);
      led.untyped--;
      dealt++;
      this.stats.typed++;
      this.stats.minMargin = Math.min(this.stats.minMargin, led.untyped - led.open.length);
    }
    if (dealt > 0) {
      if (this.stats.events === 0) this.stats.opening = dealt;
      this.stats.events++;
      this.stats.batches.push(dealt);
    }
    return dealt;
  }

  /** 局终收尾:把仍未定型的牌(只有死局会有)按账补齐,返回补的张数。
   *  每个开着的图案配一张伴;剩下的两两张配成随机图案。 */
  finish(board: Board): number {
    const led = this.ledger(board);
    const rest: number[] = [];
    for (const t of board.allTiles()) {
      if (isUnassigned(t.elementId)) rest.push(t.tileId);
    }
    if (rest.length < led.open.length) {
      throw new Error(`TypeDealer.finish: 未定型 ${rest.length} 张 < 开着的图案 ${led.open.length} 个——奇偶不变量破口`);
    }
    fisherYates(rest, this.rng);
    let n = 0;
    for (const e of led.open) {
      board.assignType(rest.pop()!, e);
      n++;
    }
    while (rest.length > 0) {
      if (rest.length < 2) {
        throw new Error('TypeDealer.finish: 剩余未定型牌数为单数——奇偶不变量破口');
      }
      const e = this.poolIds[Math.min(Math.floor(this.rng() * this.poolIds.length), this.poolIds.length - 1)];
      board.assignType(rest.pop()!, e);
      board.assignType(rest.pop()!, e);
      n += 2;
    }
    this.stats.finished = n;
    this.stats.typed += n;
    return n;
  }

  /** 成品关卡(须在局终收尾之后调用;残留占位符会被 validateLevelData 报出) */
  toLevel(board: Board): LevelData {
    const level: LevelData = {
      board: { w: board.boardSize.w, h: board.boardSize.h },
      elements: this.pool,
      tiles: board.allTiles().map(t => ({
        elementId: t.elementId, variant: t.variant,
        gx: t.gx, gy: t.gy, layer: t.layer, subZ: t.subZ,
      })),
    };
    const bad = validateLevelData(level);
    if (bad.length > 0) {
      throw new Error('布局器成品未通过校验(多半还有未定型的牌——先调 finish):\n'
        + bad.slice(0, 5).join('\n') + (bad.length > 5 ? `\n…共 ${bad.length} 条` : ''));
    }
    return level;
  }

  // ─────────────────────────── 内部 ───────────────────────────

  /** 从 Board 重数奇偶账(只有几十张牌,每次重数最稳,不跨局携带状态) */
  private ledger(board: Board): Ledger {
    const seen = new Map<string, number>();
    let untyped = 0;
    for (const t of board.allTiles()) {
      if (isUnassigned(t.elementId)) { untyped++; continue; }
      seen.set(t.elementId, (seen.get(t.elementId) ?? 0) + 1);
    }
    const open: string[] = [];
    for (const e of this.poolIds) {
      if ((seen.get(e) ?? 0) % 2 === 1) open.push(e);
    }
    return { seen, open, untyped };
  }

  /** 发一张牌:在「发了之后账还平得了」的图案里等概率抽一个,并更新开着的图案。
   *  发伴(开着的图案)永远可以;开新线(没开着的图案)要求发完 U − 1 ≥ O + 1。 */
  private draw(led: Ledger): string {
    const canOpenNew = led.untyped - 1 >= led.open.length + 1;
    const cands = canOpenNew ? this.poolIds : led.open;
    if (cands.length === 0) {
      throw new Error(`TypeDealer: 无牌可发(未定型 ${led.untyped} 张、开着 ${led.open.length} 个)——奇偶不变量破口`);
    }
    const e = cands[Math.min(Math.floor(this.rng() * cands.length), cands.length - 1)];
    const i = led.open.indexOf(e);
    if (i >= 0) led.open.splice(i, 1); else led.open.push(e);
    return e;
  }
}

// ─────────────────────────── 顶层入口 ───────────────────────────

/** 空白关卡:牌位取自骨架,类型全部是占位符(未定型)。只有布局器流程用,不过 I1/I2 自检 */
export function blankLevel(layout: LayoutSkeleton, pool: ElementDef[]): LevelData {
  return {
    board: layout.board,
    elements: pool,
    tiles: layout.tiles.map((s, i) => ({
      elementId: unassignedElementId(i),
      variant: 'FULL' as TileVariant,
      gx: s.gx, gy: s.gy, layer: s.layer, subZ: s.subZ,
    })),
  };
}

export interface DealOptions {
  /** 图案池:这关允许哪几种图案 */
  pool: ElementDef[];
  /** 发牌种子(同发牌种子 + 同代理种子 → 成品逐字节一致) */
  seed?: number;
  /** 构建局的代理参数(seed / decision 等);dealer 由本函数注入,不可覆盖 */
  agent?: AgentParams;
}

export interface DealResult {
  level: LevelData;
  /** 构建局的轨迹(= 成品不带布局器重放,逐手一致;默认梯是确定性的,与代理种子无关) */
  run: RunReport;
  dealer: TypeDealer;
  /** 构建用过的 Board(终局状态;测试与调试用) */
  board: Board;
}

/** 渐进构建一关:空白关卡 → 带布局器跑代理 → 局终收尾 → 成品 */
export function dealProgressively(layout: LayoutSkeleton, opts: DealOptions): DealResult {
  const board = new Board(blankLevel(layout, opts.pool));
  const dealer = new TypeDealer({ pool: opts.pool, seed: opts.seed });
  const run = runAgent(board, { decision: ladderPolicy(), ...opts.agent, dealer });
  dealer.finish(board);
  return { level: dealer.toLevel(board), run, dealer, board };
}
