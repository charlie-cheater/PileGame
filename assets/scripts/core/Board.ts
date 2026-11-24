// ============================================================================
// Board.ts — 牌桌:关卡运行时牌状态的单一事实源(纯逻辑,零节点依赖)
//
// 职责边界(2026-11-18 设计确认):
//   · 持有全部 Tile 实例(pile / slot / eliminated 三态),不另设 TrayModel
//     ——槽位 = status + slotIndex,槽位分配策略(最左空位)在牌桌内
//   · 操作返回结构化结果(Command result),不发事件;视图/动画由控制器驱动
//   · pick 内自动配对检测并返回 paired;控制器播完奖励动画后调 eliminate
//   · 不做:动画/音效/输赢决策(控制器/渲染)——本类是纯状态机
//
// 依赖:tile.ts(数据契约)、Occlusion.ts(派生态计算)
// 数据校验(I1~I5)归 LevelCodec,本类信任输入。
//
// 派生态 / 可见性的重算时机(2026-11-24,结果与每次全量重算逐值相同):
//   · 构造 / 撤回 / 洗牌 → 全量 refresh(并重建牌堆的遮挡关系索引)
//   · 点击入槽 → 增量:只重算被拿走那张牌直接压着的牌(refreshAfterPick)
//   · 消除 → 不重算(只动槽内的牌,牌堆没变)
// ============================================================================

import { Tile, TileDef, TileDerived, LevelData, canPair, findPairInSlot } from './tile';
import { computeOcclusion, buildOcclusionIndex, deriveAfter, OcclusionIndex } from './Occlusion';
import { computeVisibleState, visibilityAfter, summarizeVisibility, VisibleState } from './Visibility';

/** 槽位容量(不变量 I3) */
export const SLOT_COUNT = 4;

export interface PickResult {
  ok: boolean;
  reason?: 'not_found' | 'not_clickable' | 'slot_full';
  /** 本次入槽后槽内第一组可配对下标(供奖励动画);控制器事后须调 eliminate */
  paired?: [number, number];
}

export class Board {

  readonly boardSize: { w: number; h: number };

  private readonly tiles: Tile[];
  /** 构造器末尾经 refresh() 赋值 */
  private derivedMap!: Map<number, TileDerived>;
  private visibleState!: VisibleState;
  /** 当前牌堆的遮挡关系索引,及建索引以来离开牌堆的牌——pick 之后增量刷新用
   *  (见 refreshAfterPick);每次全量 refresh 时重建 */
  private occlusionIndex!: OcclusionIndex;
  private readonly offPile = new Set<number>();
  /** 入槽时间序的 tileId 栈(撤回仅允许栈顶) */
  private readonly pickStack: number[] = [];
  /** 注入随机源(洗牌可测试;缺省 Math.random) */
  private readonly rng: () => number;

  constructor(level: LevelData, rng: () => number = Math.random) {
    this.boardSize = { w: level.board.w, h: level.board.h };
    this.tiles = level.tiles.map((d: TileDef, i: number): Tile => ({
      ...d,
      tileId: i,               // 契约:tileId = 关卡数组下标
      status: 'pile',
      slotIndex: null,
    }));
    this.rng = rng;
    this.refresh();
  }

  // ─────────────────────────── 查询 ───────────────────────────

  /** 全部牌(只读视图;tileId = 数组下标) */
  allTiles(): readonly Tile[] { return this.tiles; }

  getTile(tileId: number): Tile | undefined { return this.tiles[tileId]; }

  getDerived(tileId: number): TileDerived | undefined { return this.derivedMap.get(tileId); }

  /** 当前可点击的牌(status=pile 且未被压) */
  clickableTiles(): Tile[] {
    return this.tiles.filter(t => this.derivedMap.get(t.tileId)?.clickable === true);
  }

  /** 槽内牌(按槽位下标序) */
  slotTiles(): Tile[] {
    return this.tiles
      .filter(t => t.status === 'slot')
      .sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));
  }

  slotCount(): number { return this.tiles.filter(t => t.status === 'slot').length; }

  pileCount(): number { return this.tiles.filter(t => t.status === 'pile').length; }

  /** 清空(pile+slot 全无)→ 胜利判定依据;决策权在控制器 */
  isCleared(): boolean { return this.tiles.every(t => t.status === 'eliminated'); }

  isSlotFull(): boolean { return this.slotCount() >= SLOT_COUNT; }

  /** 槽内第一组可配对(槽位下标);无则 null */
  findSlotPair(): [number, number] | null {
    const tray: Array<Tile | null> = new Array(SLOT_COUNT).fill(null);
    for (const t of this.tiles) {
      if (t.status === 'slot' && t.slotIndex !== null) tray[t.slotIndex] = t;
    }
    return findPairInSlot(tray);
  }

  // ─────────────────────────── 操作 ───────────────────────────

  /** 点击入槽:校验可点 → 最左空位 → 增量重算受影响的牌 → 返回配对检测结果 */
  pick(tileId: number): PickResult {
    const t = this.tiles[tileId];
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status !== 'pile' || this.derivedMap.get(tileId)?.clickable !== true) {
      return { ok: false, reason: 'not_clickable' };
    }
    const empty = this.firstEmptySlot();
    if (empty < 0) return { ok: false, reason: 'slot_full' };

    t.status = 'slot';
    t.slotIndex = empty;
    this.pickStack.push(tileId);
    this.refreshAfterPick(t);

    const pair = this.findSlotPair();
    return { ok: true, paired: pair ?? undefined };
  }

  /** 配对移除(奖励动画播完后调用):按槽位下标移除一对互补牌 */
  eliminate(slotI: number, slotJ: number): boolean {
    const a = this.tileAtSlot(slotI);
    const b = this.tileAtSlot(slotJ);
    if (!a || !b || !canPair(a, b)) return false;
    a.status = 'eliminated'; a.slotIndex = null;
    b.status = 'eliminated'; b.slotIndex = null;
    this.removeFromStack(a.tileId);
    this.removeFromStack(b.tileId);
    // 不重算派生态 / 可见性(2026-11-24):两者都只看牌堆上的牌,消除只动槽内的牌;
    // 这两张牌的派生态入槽时已是「不可点」,与消除后相同
    return true;
  }

  /** 撤回:仅允许最后入槽的一张(slot → pile,坐标未变) */
  recall(tileId: number): boolean {
    const t = this.tiles[tileId];
    if (!t || t.status !== 'slot') return false;
    if (this.pickStack[this.pickStack.length - 1] !== tileId) return false;
    t.status = 'pile';
    t.slotIndex = null;
    this.pickStack.pop();
    this.refresh();
    return true;
  }

  /** 洗牌:未消除牌在各自层内重排位置(gx/gy 层内置换;layer/subZ 不变) */
  shuffle(): void {
    const byLayer = new Map<number, Tile[]>();
    for (const t of this.tiles) {
      if (t.status !== 'pile') continue;
      const arr = byLayer.get(t.layer) ?? [];
      arr.push(t);
      byLayer.set(t.layer, arr);
    }
    byLayer.forEach((layerTiles: Tile[]) => {
      const xs = layerTiles.map(t => t.gx);
      const ys = layerTiles.map(t => t.gy);
      // Fisher-Yates:同一层的 (gx, gy) 成对置换,保持"位置集合"不变
      for (let i = layerTiles.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [xs[i], xs[j]] = [xs[j], xs[i]];
        [ys[i], ys[j]] = [ys[j], ys[i]];
      }
      layerTiles.forEach((t, i) => { t.gx = xs[i]; t.gy = ys[i]; });
    });
    this.refresh();
  }

  /** 槽位紧凑化:消除后按现有顺序将 slotIndex 重排为 0..n-1 */
  compactSlots(): void {
    this.slotTiles().forEach((t, k) => { t.slotIndex = k; });
  }

  // ─────────────────────────── 内部 ───────────────────────────

  /** 全量重算派生态与可见性(构造 / 撤回 / 洗牌后);同时按当前牌堆重建遮挡关系
   *  索引,供之后每次 pick 增量刷新 */
  private refresh(): void {
    this.occlusionIndex = buildOcclusionIndex(this.tiles.filter(t => t.status === 'pile'));
    this.offPile.clear();
    this.derivedMap = computeOcclusion(this.tiles);
    this.visibleState = computeVisibleState(this.tiles);
  }

  /** pick 之后的增量刷新(2026-11-24):牌堆里只少了 x 一张,会变的只有它直接压着的牌
   *  (其余牌的覆盖贡献不变);消除不动牌堆,不重算。结果与全量 refresh 逐值相同
   *  (tests/board-state 有回归)。派生态与可见性换成新对象——先前取走的引用仍是
   *  旧快照,与全量重算时一致 */
  private refreshAfterPick(x: Tile): void {
    this.offPile.add(x.tileId);
    const index = this.occlusionIndex;
    const derivedMap = new Map(this.derivedMap);
    const byTile = new Map(this.visibleState.byTile);
    for (const id of index.coveredBy.get(x.tileId) ?? []) {
      const t = this.tiles[id];
      if (t.status !== 'pile') continue;   // 先前已被拿走的牌:不在牌堆上,不受影响
      derivedMap.set(id, deriveAfter(index, t, this.offPile));
      byTile.set(id, visibilityAfter(index, t, this.offPile));
    }
    derivedMap.set(x.tileId, deriveAfter(index, x, this.offPile));
    byTile.delete(x.tileId);
    this.derivedMap = derivedMap;
    this.visibleState = { byTile, ...summarizeVisibility(byTile) };
  }

  /** 当前版面可见状态(每次牌堆变化后随 refresh 更新) */
  getVisibleState(): VisibleState { return this.visibleState; }

  private firstEmptySlot(): number {
    const occupied = new Set<number>();
    for (const t of this.tiles) {
      if (t.status === 'slot' && t.slotIndex !== null) occupied.add(t.slotIndex);
    }
    for (let s = 0; s < SLOT_COUNT; s++) {
      if (!occupied.has(s)) return s;
    }
    return -1;
  }

  private tileAtSlot(slotIndex: number): Tile | undefined {
    return this.tiles.find(t => t.status === 'slot' && t.slotIndex === slotIndex);
  }

  private removeFromStack(tileId: number): void {
    const i = this.pickStack.indexOf(tileId);
    if (i >= 0) this.pickStack.splice(i, 1);
  }
}
