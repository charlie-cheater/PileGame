// ============================================================================
// ShadowState.ts — 影子状态(搜索用轻量局面投影;2026-11-26 设计者指示立项)
//
// 出处:P3 状态归约推论(context/background/solvability-research.md)——
//   遮挡是开局定死的结构事实(z 序 + 几何,对局中不变),槽内容可由已移除集导出
//   ⇒ 任意假想局面 = 位集 R(已飞入槽的牌,含已消除),可点性 = directBlockers[t]
//   ⊆ R 近 O(1) 判定。搜索在影子上分支与回退免费;真局仍由 Board 驱动,
//   影子只做规划/假设,不落盘。
//
// 语义(与 Board 严格同构):
//   · R = 非 pile 状态的牌(slot + eliminated);板上牌 = 补集
//   · 元素开对 = 该元素已入槽张数的奇偶(全图匹配口径:同元素即可配,第二张
//     入槽立即消除;当前语料全 FULL,L/R 半别约束留待需要时按 变体×元素 计数扩展)
//   · 容量约束 = 任意时刻开对 ≤ SLOT_COUNT - 1(第 SLOT_COUNT 张必须闭对)。
//     「开对满时拿一张不闭对」在真局即判负,影子里记为非法着——搜索只走合法着
//   · 合法着 = 可点 且 (闭对 或 开对未满)
//   · 终局二分:清盘(全部移除**且无开对滞留**;Board 语义 = 每张都 eliminated)
//     = 胜;无合法着且未清盘 = 死局。
//     P1 单调性(DAG)保证未清盘必有可点牌,「无合法着」只发生在 开对满且无闭对
//     或板上已掏空(滞留孤儿)——与 Board 的 isSlotFull() && !findSlotPair() 判负、
//     pile 空 no_clickable 同构(等价性由套件核对)
//
// 复杂度:pick / undo O(1);isClickable O(|直接阻塞者|);clickableTiles /
// legalMoves O(n × 平均阻塞者数)。按 n ≤ ~300 的语料规模,搜索数千假想节点
// 为毫秒级;不调 analyze、不刷可见性、不驱动 Board。
// ============================================================================

import { SLOT_COUNT } from './Board';
import { OcclusionTopology } from './OcclusionTopology';

/** 影子状态需要的牌面信息(只需 tileId 与元素归属;几何已在 topo 里) */
export interface ShadowTileRef {
  tileId: number;
  elementId: string;
}

export interface ShadowState {
  /** 已移除张数 |R| */
  removedCount(): number;
  /** 总张数 */
  tileCount(): number;
  /** 可点性:该牌的全部直接阻塞者都已移除 */
  isClickable(tileId: number): boolean;
  /** 全部可点牌(tileId 升序) */
  clickableTiles(): number[];
  /** 当前开对总数(= 真局槽内张数:槽里永远只有未闭合的半张) */
  opens(): number;
  /** 某元素当前是否有半张开在槽里 */
  elementOpen(elementId: string): boolean;
  /** 合法着判定:可点 且 (闭对 或 开对未满) */
  canPick(tileId: number): boolean;
  /** 全部合法着(tileId 升序) */
  legalMoves(): number[];
  /** 执行拾取;返回是否闭对。非法着返回 null 且不变更状态 */
  pick(tileId: number): boolean | null;
  /** 回退一张(免费;该牌必须此前已 pick 入影) */
  undo(tileId: number): void;
  /** 清盘(全部移除)= 胜利终局 */
  isCleared(): boolean;
  /** 死局终局:未清盘 且 无合法着 */
  isDead(): boolean;
  /** 分支副本(深拷贝内部计数;用于需要并行假设的搜索) */
  clone(): ShadowState;
}

/** 由静态遮挡拓扑 + 牌面元素归属构建影子状态;removed 给出初始已移除集
 *  (从中局接管时 = 非 pile 状态的牌,即 slot + eliminated) */
export function createShadowState(
  topo: OcclusionTopology,
  tiles: ReadonlyArray<ShadowTileRef>,
  removed?: ReadonlySet<number>,
): ShadowState {
  const n = tiles.length;
  const elementOf = new Map<number, string>();
  for (const t of tiles) elementOf.set(t.tileId, t.elementId);

  const inSlot = new Set<number>(removed ?? []);
  // 每元素已移除张数(开对奇偶的增量维护)
  const removedPerElement = new Map<string, number>();
  let opens = 0;
  let removedCount = 0;
  for (const t of tiles) {
    if (inSlot.has(t.tileId)) {
      removedCount++;
      const e = t.elementId;
      const c = removedPerElement.get(e) ?? 0;
      removedPerElement.set(e, c + 1);
      // 放入后该元素张数奇 ⇒ 槽里多一张开对;偶 ⇒ 闭对离场
      if ((c + 1) % 2 === 1) opens++; else opens--;
    }
  }

  const maxOpens = SLOT_COUNT - 1;        // 第 SLOT_COUNT 张必须闭对

  const state: ShadowState = {
    removedCount: () => removedCount,
    tileCount: () => n,

    isClickable(tileId: number): boolean {
      if (inSlot.has(tileId)) return false;       // 已入影 = 不在板上:不可再拿
      const blockers = topo.directBlockers.get(tileId);
      if (blockers === undefined) return false;   // 未知牌:不可点(防御)
      for (const b of blockers) {
        if (!inSlot.has(b)) return false;
      }
      return true;
    },

    clickableTiles(): number[] {
      const out: number[] = [];
      for (const t of tiles) {
        if (state.isClickable(t.tileId)) out.push(t.tileId);
      }
      return out;                           // tiles 按 tileId 升序 → 输出升序
    },

    opens: () => opens,

    elementOpen(elementId: string): boolean {
      return ((removedPerElement.get(elementId) ?? 0) % 2) === 1;
    },

    canPick(tileId: number): boolean {
      if (!state.isClickable(tileId)) return false;
      if (state.elementOpen(elementOf.get(tileId)!)) return true;   // 闭对:恒合法
      return opens < maxOpens;              // 开新对:须有余位
    },

    legalMoves(): number[] {
      const out: number[] = [];
      for (const t of tiles) {
        if (state.canPick(t.tileId)) out.push(t.tileId);
      }
      return out;
    },

    pick(tileId: number): boolean | null {
      if (!state.canPick(tileId)) return null;
      const e = elementOf.get(tileId)!;
      const closed = (removedPerElement.get(e) ?? 0) % 2 === 1;
      inSlot.add(tileId);
      removedPerElement.set(e, (removedPerElement.get(e) ?? 0) + 1);
      opens += closed ? -1 : 1;
      removedCount++;
      return closed;
    },

    undo(tileId: number): void {
      if (!inSlot.has(tileId)) return;
      const e = elementOf.get(tileId)!;
      const cnt = removedPerElement.get(e) ?? 0;
      // 该牌入影时是否闭了对:入影前该元素张数为奇 ⇒ 闭对
      const closed = (cnt - 1) % 2 === 1;
      inSlot.delete(tileId);
      removedPerElement.set(e, cnt - 1);
      opens += closed ? 1 : -1;
      removedCount--;
    },

    isCleared: () => removedCount === n && opens === 0,

    isDead(): boolean {
      if (state.isCleared()) return false;
      return state.legalMoves().length === 0;
    },

    clone(): ShadowState {
      return createShadowState(topo, tiles, inSlot);
    },
  };
  return state;
}
