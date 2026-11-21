// ============================================================================
// Depth.ts — 深度计算(逆向构造法·方案 A 的核心度量)
//
// 定义:depth(t) = t 变为可点前必须完成的移除轮次
//   depth(t) = 0                若无遮挡者
//   depth(t) = 1 + max{ depth(j) | j 遮挡 t }   (取最长链:t 可点需全部遮挡者移走)
//
// 算法:z 是严格全序((layer, subZ, tileId) 字典序),按 z 降序单遍扫描——
// 处理任一 slot 时,其全部遮挡者(z 更高)均已算完,无需显式拓扑排序。
// 遮挡判定复用 Occlusion.blocksOcclusion(口径 v2.1 单一事实源)。
//
// 用途:
//   · waves 升序 = 可玩波次;降序遍历 = 逆向构造的放置波次(可解性归纳基础)
//   · 对内深度差 Δ = 难度旋钮(同波安全 / 跨波槽压)
//   · maxDepth = 关卡深度标量(难度曲线原料)
// ============================================================================

import { OcclusionSubject, blocksOcclusion, isAbove } from './Occlusion';

/** 深度计算的位置输入(Tile 结构兼容) */
export type DepthSlot = OcclusionSubject;

export interface DepthReport {
  /** slotId → 深度(0 = 顶层,立即可点) */
  depth: Map<number, number>;
  /** 按 depth 升序:waves[d] = 深度 d 的 slotId 集合 */
  waves: number[][];
  /** 关卡最大深度 */
  maxDepth: number;
}

/** O(V²)(V ≤ ~60);确定性,无随机 */
export function computeDepths(slots: ReadonlyArray<DepthSlot>): DepthReport {
  const depth = new Map<number, number>();

  // z 降序:高者先算(遮挡者先于被遮挡者就绪)
  const sorted = [...slots].sort((a, b) =>
    isAbove(a, b) ? -1 : isAbove(b, a) ? 1 : 0);

  for (const s of sorted) {
    let d = 0;
    for (const other of slots) {
      if (other.tileId === s.tileId) continue;
      if (blocksOcclusion(other, s)) {
        d = Math.max(d, (depth.get(other.tileId) ?? 0) + 1);
      }
    }
    depth.set(s.tileId, d);
  }

  let maxDepth = 0;
  depth.forEach(d => { maxDepth = Math.max(maxDepth, d); });

  const waves: number[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const s of slots) {
    waves[depth.get(s.tileId) ?? 0].push(s.tileId);
  }

  return { depth, waves, maxDepth };
}
