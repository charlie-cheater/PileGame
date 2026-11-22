// ============================================================================
// OcclusionTopology.ts — 遮挡拓扑(关卡预处理,2026-11-20 设计确认)
//
// 目的:记录每张牌的直接遮挡者并递归构建完整遮挡关系,支持动态计算
// "让某个被遮挡 tile 暴露"的可能操作路径。
//
// 语义(与既有规则严格衔接;2026-11-22 v3 并集口径同步):
//   · 直接阻塞者 = 对该牌有任意正面积覆盖贡献的 z 更高牌(coversAny)
//     —— 充分性保持:移除全部贡献者 ⇔ 必然暴露(覆盖并集归零);
//        个体必要性不再保证:并集口径下可能存在冗余贡献者(移除它对
//        并集是否超阈无影响),最小必要集是直接阻塞者的子集,
//        由后续求解/按并集阈值裁剪处理
//   · 传递闭包 = 递归全部前置;DAG 无环由 z 沿边严格递增保证
//   · 暴露路径 = 闭包 DAG 的线性扩展(合法移除序,不含 target 自身;
//     保守骨架:按此序移除必暴露,但未必是最短序)
//
// 闭环提示:移除在真实玩法中经"配对"发生 —— 单张阻塞者自身也有 mate,
// 路径语义是"移除序骨架",配对可行性叠加由后续逆构造/求解器负责。
// ============================================================================

import { OcclusionSubject, coversAny } from './Occlusion';

export type TopologySlot = OcclusionSubject;

export interface OcclusionTopology {
  /** tileId → 直接阻塞者(暴露该牌的最小必要移除集) */
  directBlockers: Map<number, number[]>;
  /** tileId → 被它直接阻塞的牌(反向边;移除它对暴露谁的直接贡献) */
  directBlocks: Map<number, number[]>;
  /** tileId → 传递闭包(全部直接+间接前置;拓扑升序:前置在前) */
  allBlockers: Map<number, number[]>;
  /** tileId → 最长前置链长(与 Depth.depth 同值,冗余便捷字段) */
  depth: Map<number, number>;
  /** 全局最大深度 */
  maxDepth: number;
}

/** O(V²) 建边 + O(V+E) 闭包 DFS;确定性输出(邻居按 tileId 升序) */
export function buildOcclusionTopology(tiles: ReadonlyArray<TopologySlot>): OcclusionTopology {
  const directBlockers = new Map<number, number[]>();
  const directBlocks = new Map<number, number[]>();
  for (const t of tiles) {
    directBlockers.set(t.tileId, []);
    directBlocks.set(t.tileId, []);
  }
  for (const t of tiles) {
    for (const o of tiles) {
      if (o.tileId === t.tileId) continue;
      if (coversAny(o, t)) {
        directBlockers.get(t.tileId)!.push(o.tileId);
        directBlocks.get(o.tileId)!.push(t.tileId);
      }
    }
  }
  // 确定性:邻居升序
  const sortAsc = (arr: number[]) => arr.sort((a, b) => a - b);
  directBlockers.forEach(sortAsc);
  directBlocks.forEach(sortAsc);

  // 传递闭包(记忆化 DFS;DAG 由 z 严格递增保证)
  const allBlockers = new Map<number, number[]>();
  const depth = new Map<number, number>();
  const closureOf = (id: number, visiting: Set<number>): number[] => {
    const cached = allBlockers.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return [];            // 理论不可达(DAG),防御
    visiting.add(id);
    const set = new Set<number>();
    let d = 0;
    for (const b of directBlockers.get(id)!) {
      set.add(b);
      for (const x of closureOf(b, visiting)) set.add(x);
      d = Math.max(d, (depth.get(b) ?? 0) + 1);
    }
    visiting.delete(id);
    const arr = Array.from(set).sort((a, b) => {
      const ka = zOf(tiles, a), kb = zOf(tiles, b);
      return ka !== kb ? ka - kb : a - b;      // 拓扑升序(z 升序 = 前置在前)
    });
    allBlockers.set(id, arr);
    depth.set(id, d);
    return arr;
  };
  let maxDepth = 0;
  for (const t of tiles) {
    closureOf(t.tileId, new Set());
    maxDepth = Math.max(maxDepth, depth.get(t.tileId) ?? 0);
  }

  return { directBlockers, directBlocks, allBlockers, depth, maxDepth };
}

function zOf(tiles: ReadonlyArray<TopologySlot>, id: number): number {
  // z 序标量 = layer×1e9 + subZ×1e6 + tileId(double 精度内无碰撞)
  const t = tiles.find(x => x.tileId === id)!;
  return t.layer * 1e9 + (t.subZ ?? 0) * 1e6 + t.tileId;
}

// ─────────────────────────── 动态查询:暴露路径 ───────────────────────────

export interface ExposePathOptions {
  /** 已移除牌集合(运行时过滤:从当前局面出发) */
  removed?: ReadonlySet<number>;
  /** 最多返回路径数(默认 16;组合爆炸保护) */
  maxPaths?: number;
}

/**
 * 枚举"让 targetId 暴露"的可能操作路径(移除序,不含 target 自身)。
 * 每条路径都是闭包 DAG 的线性扩展;已移除牌从闭包中剔除。
 * 路径数最坏为指数级 —— maxPaths 硬上限保护,返回时按 DFS 序截断。
 */
export function enumerateExposePaths(
  topo: OcclusionTopology,
  targetId: number,
  opts: ExposePathOptions = {},
): number[][] {
  const removed = opts.removed ?? new Set<number>();
  const maxPaths = opts.maxPaths ?? 16;
  const need = (topo.allBlockers.get(targetId) ?? []).filter(id => !removed.has(id));
  const direct = new Set((topo.directBlockers.get(targetId) ?? []).filter(id => !removed.has(id)));
  const paths: number[][] = [];
  if (need.length === 0) return [[]];            // 已暴露(或本就顶层):空操作即暴露

  const remaining = new Set(need);
  const path: number[] = [];
  const hasPendingBlocker = (id: number): boolean =>
    (topo.allBlockers.get(id) ?? []).some(b => remaining.has(b));
  const dfs = (available: number[]): void => {
    if (paths.length >= maxPaths) return;
    if (remaining.size === 0) { paths.push([...path]); return; }
    for (let i = 0; i < available.length && paths.length < maxPaths; i++) {
      const id = available[i];
      path.push(id);
      remaining.delete(id);
      // 新可用 = id 直接解锁的后继中已无未移除前置者
      const next = (topo.directBlocks.get(id) ?? [])
        .filter(x => remaining.has(x) && !hasPendingBlocker(x));
      dfs([...available.filter(x => x !== id), ...next]);
      remaining.add(id);
      path.pop();
    }
  };
  // 初始可用:闭包内已无未移除前置的成员(前置若在闭包外,必属已移除)
  dfs(need.filter(id => !hasPendingBlocker(id)));
  return paths;
}

/**
 * 暴露路径计数(精确):闭包 ≤ maxClosureSize(默认 20)时用子集 DP,
 * 否则返回 -1(数量过大,请用 enumerateExposePaths 截断枚举)。
 */
export function countExposePaths(
  topo: OcclusionTopology,
  targetId: number,
  removed: ReadonlySet<number> = new Set(),
  maxClosureSize = 20,
): number {
  const need = (topo.allBlockers.get(targetId) ?? []).filter(id => !removed.has(id));
  if (need.length === 0) return 1;
  if (need.length > maxClosureSize) return -1;
  const index = new Map<number, number>();
  need.forEach((id, i) => index.set(id, i));
  const blockMask = new Map<number, number>();   // id → 其在闭包内的前置位掩码
  for (const id of need) {
    let mask = 0;
    for (const b of topo.allBlockers.get(id) ?? []) {
      if (index.has(b)) mask |= (1 << index.get(b)!);
    }
    blockMask.set(id, mask);
  }
  const memo = new Map<number, number>();
  const fullMask = (1 << need.length) - 1;
  const count = (placed: number): number => {
    if (placed === fullMask) return 1;           // 完整排列 = 1 条
    if (memo.has(placed)) return memo.get(placed)!;
    let total = 0;
    for (let i = 0; i < need.length; i++) {
      const bit = 1 << i;
      if (placed & bit) continue;
      if ((blockMask.get(need[i])! & placed) !== blockMask.get(need[i])!) continue;
      total += count(placed | bit);
    }
    memo.set(placed, total);
    return total;
  };
  return count(0);
}
