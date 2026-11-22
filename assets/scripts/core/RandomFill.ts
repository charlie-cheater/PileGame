// ============================================================================
// RandomFill.ts — 随机配对填充(位置骨架 → FULL 牌面数据)
//
// 定位:关卡生成管线中最简单的填充算法(2026-11-22)——位置两两随机配对,
// 每对随机分配一个元素(两张均 FULL,全图匹配口径)。可解性不保证(随机
// 散布);为仿真玩家代理提供批量迭代用的关卡语料,后续由规划器/构造式
// 生成取代(见 context/map/nodes/level-generation.md)。
//
// 确定性:seed 注入 LCG(LevelBuilder 共用),同 seed 逐字节一致;
// tileId = 返回数组下标(与 Board 契约一致,序 = slots 序)。
// ============================================================================

import { OcclusionSubject } from './Occlusion';
import { ElementDef, LevelData, TileDef, Unit } from './tile';
import { lcg, fisherYates, validateLevelData } from './LevelBuilder';

export interface FillOptions {
  /** 参与元素池 */
  elements: ElementDef[];
  /** 每元素对数;缺省自动均分(前 rem 个元素各 +1 对) */
  pairsPerElement?: number;
  /** 随机种子(缺省非确定) */
  seed?: number;
}

/** 位置骨架 → 随机配对填充(FULL 口径)。返回序 = slots 序(tileId = 数组下标)。 */
export function fillSlots(slots: ReadonlyArray<OcclusionSubject>, opts: FillOptions): TileDef[] {
  if (slots.length % 2 !== 0) {
    throw new Error(`牌数为奇数(${slots.length}),无法配对填充(I1)`);
  }
  const totalPairs = slots.length / 2;

  // 元素配额(与 LevelBuilder 同口径:显式严格校验 / 余数分配)
  let quotas: number[];
  if (opts.pairsPerElement !== undefined) {
    const pp: number = opts.pairsPerElement;
    if (opts.elements.length * pp !== totalPairs) {
      throw new Error(`配额不符:${opts.elements.length} 元素 × ${pp} 对 ≠ ${totalPairs} 对`);
    }
    quotas = opts.elements.map(() => pp);
  } else {
    const base = Math.floor(totalPairs / opts.elements.length);
    const rem = totalPairs % opts.elements.length;
    quotas = opts.elements.map((_, i) => base + (i < rem ? 1 : 0));
  }

  const rng = opts.seed !== undefined ? lcg(opts.seed) : Math.random;

  // 元素袋(每对一签)洗牌 + 位置序洗牌 → 逐对分配
  const bag: ElementDef[] = [];
  opts.elements.forEach((e, i) => { for (let n = 0; n < quotas[i]; n++) bag.push(e); });
  fisherYates(bag, rng);

  const order = slots.map((_, i) => i);
  fisherYates(order, rng);

  const assignment = new Array<string>(slots.length);
  for (let p = 0; p < totalPairs; p++) {
    assignment[order[2 * p]] = bag[p].elementId;
    assignment[order[2 * p + 1]] = bag[p].elementId;
  }

  return slots.map((s, i): TileDef => ({
    elementId: assignment[i],
    variant: 'FULL',
    gx: s.gx,
    gy: s.gy,
    layer: s.layer,
    subZ: s.subZ,
  }));
}

/** 骨架 + 随机填充 → 完整 LevelData(board 尺寸显式给出;含 I1~I5 自检) */
export function buildFilledLevel(
  board: { w: Unit; h: Unit },
  slots: ReadonlyArray<OcclusionSubject>,
  opts: FillOptions,
): LevelData {
  const level: LevelData = {
    board,
    elements: opts.elements,
    tiles: fillSlots(slots, opts),
  };
  const violations = validateLevelData(level);
  if (violations.length > 0) {
    throw new Error('随机填充自检失败:\n' + violations.join('\n'));
  }
  return level;
}
