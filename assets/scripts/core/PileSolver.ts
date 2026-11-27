// ============================================================================
// PileSolver.ts — 单侧验证器(理想求解器;2026-11-26 设计者批准,评估层专用)
//
// 定位:效果评估的「可达上限」量尺(context/background/solvability-research.md
// §验证的不对称性 §de Bondt 技术阶梯)。评估层允许客观(偷看全量牌表),
// 代理层保持主观——量尺与玩家口径分离,求解结果不得进入任何决策路径。
//
// 口径(单侧验证器):找到解 = 确定可解(附见证序列);预算内找不到 = UNKNOWN,
// 不证伪。可点性判定 = Occlusion v3 精确口径(buildOcclusionIndex + blockedAfter,
// 并集阈值 + 侧边擦及,与 Board/感知逐位一致;coversAny 直接阻挡集只是充分不必要,
// 2026-11-26 实测会产出非法见证,故弃用)。
//
// 算法(有界 DFS,状态按值传递):
//   1. 状态对象 { removed 集合, 各元素已移除数, 开对数, 位集键 } 在分支时**克隆
//      传递**,失败即丢弃——不存在手工回退,见证栈与状态天然一致
//      (2026-11-26:共享可变状态 + unwind 的首版曾因回退错位产出非法见证,重写)
//   2. 分支:可点牌逐一尝试;闭对恒合法,开新对须开对数 ≤ 2(第 4 张开新对 =
//      真局判负着);候选 tileId 升序(确定性);记忆化:失败态位集键入
//      visited,重遇即败(去排列冗余,de Bondt §交换律规范化)
//   3. 预算:节点数上限(确定性;同参数重跑逐节点一致),超限 → UNKNOWN
//
// ⛔ P2 折叠(double/close 强制前置)曾按调研档引入,实测**不保解**:盘
//   1000(14 元素)代理式清盘线在折叠搜索下被判 UNKNOWN,同线在无折叠穷举
//   下可解(2026-11-26;复现脚本 temp/probe-fold-bisect.js、反例狩猎
//   temp/probe-solver-vs-brute.js——小盘 120/120 一致,诱因未定位)。折叠是
//   剪枝优化而非正确性必需,已整体移除;搜索退化为穷举 + 记忆化 + 预算。
//
// 复杂度:每分支节点克隆状态 O(n) + 可点性判定 O(贡献者并集);记忆化把
// 排列冗余压成组合。预算内可解率多高,由评估运行回答。
// ============================================================================

import { SLOT_COUNT } from './Board';
import { Tile } from './tile';
import { OcclusionIndex, buildOcclusionIndex, blockedAfter } from './Occlusion';

export interface SolveOptions {
  /** 搜索节点预算(默认 200000;确定性口径,超限 = UNKNOWN) */
  maxNodes?: number;
  /** 中局接管:初始已移除集(槽内 + 已消除;缺省空盘起步) */
  initialRemoved?: ReadonlySet<number>;
  /** 预构建的遮挡索引(同盘多次求解时复用;缺省内部构建) */
  index?: OcclusionIndex;
}

export interface SolveResult {
  status: 'solved' | 'unknown';
  /** 见证序列(solved 时给出):从初始状态起的全量拿牌序,逐张在 Board 上
   *  重放(拿 + 闭对消除)应清盘——由套件核对 */
  witness: number[];
  /** 实际搜索节点数(确定性) */
  nodes: number;
}

/** 搜索节点状态(按值传递;分支即克隆) */
interface SolverState {
  removed: Set<number>;
  bits: Uint32Array;
  elemRemoved: Int32Array;
  opens: number;
  removedCount: number;
}

const BUDGET = Symbol('budget');
const maxOpens = SLOT_COUNT - 1;

/** 求解:是否存在从初始状态出发、容量约束内清盘的拿牌序列 */
export function solvePile(
  tiles: ReadonlyArray<Tile>,
  opts: SolveOptions = {},
): SolveResult {
  const n = tiles.length;
  const maxNodes = opts.maxNodes ?? 200000;
  const index = opts.index ?? buildOcclusionIndex(tiles);
  const words = Math.ceil(n / 32) || 1;

  // 元素编号(全图匹配口径:同元素即可配;语料全 FULL)
  const elemIndex = new Map<string, number>();
  const elemOf = new Int32Array(n);
  tiles.forEach(t => {
    let idx = elemIndex.get(t.elementId);
    if (idx === undefined) { idx = elemIndex.size; elemIndex.set(t.elementId, idx); }
    elemOf[t.tileId] = idx;
  });
  const elemCount = elemIndex.size;

  // 初始状态
  const removed = new Set<number>(opts.initialRemoved ?? []);
  const bits = new Uint32Array(words);
  const elemRemoved = new Int32Array(elemCount);
  let removedCount = 0;
  for (const id of removed) {
    if (id < 0 || id >= n) continue;
    bits[id >> 5] |= 1 << (id & 31);
    removedCount++;
    elemRemoved[elemOf[id]]++;
  }
  // 开对数 = 奇数张元素个数(按终态奇偶重算;逐张计数会把同元素的多次移除重复累加)
  let opens = 0;
  for (let e = 0; e < elemCount; e++) {
    if (elemRemoved[e] % 2 === 1) opens++;
  }
  const root: SolverState = { removed, bits, elemRemoved, opens, removedCount };

  const isClickable = (st: SolverState, t: number) =>
    !st.removed.has(t) && !blockedAfter(index, t, st.removed);

  const pick = (st: SolverState, t: number, path: number[]) => {
    st.removed.add(t);
    st.bits[t >> 5] |= 1 << (t & 31);
    st.removedCount++;
    const e = elemOf[t];
    st.elemRemoved[e]++;
    const closed = st.elemRemoved[e] % 2 === 0;     // 放入后偶 ⇒ 闭对离场
    if (closed) st.opens--; else st.opens++;
    path.push(t);
  };

  let nodes = 0;
  let budgetBlown = false;
  const visited = new Set<string>();

  /** 返回 true = 可解(path 即见证)。状态按值传递,失败即弃,无手工回退 */
  const search = (st: SolverState, path: number[]): boolean => {
    nodes++;
    if (nodes > maxNodes) { budgetBlown = true; throw BUDGET; }
    if (st.removedCount === n && st.opens === 0) return true;   // 清盘(path 即见证)
    let key = '';
    for (let w = 0; w < words; w++) key += st.bits[w].toString(36) + ',';
    if (visited.has(key)) return false;
    for (let t = 0; t < n; t++) {                               // 候选 = 可点牌;闭对恒合法,开新对须 opens ≤ 2
      if (!isClickable(st, t)) continue;
      const closed = st.elemRemoved[elemOf[t]] % 2 === 1;
      if (!closed && st.opens >= maxOpens) continue;            // 第 4 张开新对 = 真局判负着,不入线
      const next: SolverState = {
        removed: new Set(st.removed),
        bits: st.bits.slice(),
        elemRemoved: st.elemRemoved.slice(),
        opens: st.opens,
        removedCount: st.removedCount,
      };
      pick(next, t, path);
      if (search(next, path)) return true;
      path.pop();                                               // 失败:截断本候选(状态随 next 弃)
      if (budgetBlown) throw BUDGET;
    }
    visited.add(key);
    return false;
  };

  try {
    const path: number[] = [];
    const solved = search(root, path);
    return { status: solved ? 'solved' : 'unknown', witness: solved ? path.slice() : [], nodes };
  } catch (e) {
    if (e === BUDGET) return { status: 'unknown', witness: [], nodes };
    throw e;
  }
}
