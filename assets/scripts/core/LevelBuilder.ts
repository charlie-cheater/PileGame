// ============================================================================
// LevelBuilder.ts — 牌桌(关卡)构建器:堆叠配置 → LevelData / Board
//
// 职责:
//   1. 按声明式堆叠配置(PilePattern)生成牌位(gx, gy, layer)
//   2. 配对分配:位置两两成对,随机分配 elementId + L/R(保证 I1 守恒)
//   3. 自检:I1/I2/I4/I5 不变量校验(后续 LevelCodec 可复用/接管)
//   4. boardSize 由实际摆放推导(自动满足 I5 边界)
//
// 几何口径:
//   金字塔骑缝偏移 = 半牌:x 方向 TILE.w/2 = 2(整数 ✓);
//   y 方向 TILE.h/2 = 2.5 非整数 → 取 stepY = 3 上偏整数的近似
//   (2026-11-18 视觉审阅:stepY=2 明显偏下,设计者要求上移 1 unit),
//   跨层遮挡经 totalRect 覆盖 30%,阈值 18% 下判定稳健。
//
// 确定性:seed 注入内部 LCG,同 seed 重建结果逐字节一致。
// ============================================================================

import { Board } from './Board';
import { ElementDef, LevelData, TileDef, TILE, Unit } from './tile';

// ─────────────────────────── 堆叠配置(声明式) ───────────────────────────

/** 金字塔堆叠:第 k 层为 (cols-k)×(rows-k),逐层骑缝收缩 */
export interface PyramidPattern {
  kind: 'pyramid';
  /** 底层列数(x 方向牌数) */
  cols: number;
  /** 底层行数(y 方向牌数) */
  rows: number;
  /** 层数;顶层为 (cols-layers+1)×(rows-layers+1),须 ≥ 1 */
  layers: number;
  /** 同层列距(默认 TILE.w,边靠边不重叠) */
  pitchX?: Unit;
  /** 同层行距(默认 TILE.h) */
  pitchY?: Unit;
  /** 每上一层 x 偏移(默认 2 = 半宽骑缝) */
  stepX?: Unit;
  /** 每上一层 y 偏移(默认 6 = 0.6×h,旧校准 3/5 的 2× 等比缩放,视觉审阅沿革) */
  stepY?: Unit;
  /** 布局原点 x(默认 0) */
  baseX?: Unit;
  /** 布局原点 y(默认 TILE.sideH,满足 I5 下界) */
  baseY?: Unit;
}

/** 关卡规格:布局模式 + 元素池 + 配对参数 */
export interface LevelSpec {
  pattern: PyramidPattern;
  /** 参与元素表(含底色);配对只从池内分配 */
  elements: ElementDef[];
  /** 每元素配对数;缺省自动均分(须整除) */
  pairsPerElement?: number;
  /** 随机种子(缺省非确定) */
  seed?: number;
}

// ─────────────────────────── 构建 ───────────────────────────

/** 由规格生成关卡数据(牌序 = 层升序 → 行 → 列,稳定 tileId) */
export function buildLevel(spec: LevelSpec): LevelData {
  const p = spec.pattern;
  const pitchX = p.pitchX ?? TILE.w;
  const pitchY = p.pitchY ?? TILE.h;
  const stepX = p.stepX ?? TILE.w / 2;
  const stepY = p.stepY ?? 6;
  const baseX = p.baseX ?? 0;
  const baseY = p.baseY ?? TILE.sideH;

  if (p.cols < p.layers || p.rows < p.layers) {
    throw new Error(`金字塔层数(${p.layers})超过底面尺寸(${p.cols}×${p.rows})`);
  }

  // 1. 生成牌位(层 → 行 → 列 的稳定顺序)
  interface Slot { gx: Unit; gy: Unit; layer: number; }
  const slots: Slot[] = [];
  for (let k = 0; k < p.layers; k++) {
    for (let j = 0; j <= p.rows - 1 - k; j++) {
      for (let i = 0; i <= p.cols - 1 - k; i++) {
        slots.push({
          gx: baseX + i * pitchX + k * stepX,
          gy: baseY + j * pitchY + k * stepY,
          layer: k,
        });
      }
    }
  }

  // 2. 配对守恒预检(I1:总牌数必须为偶数)
  if (slots.length % 2 !== 0) {
    throw new Error(
      `总牌数 ${slots.length} 为奇数,违反 I1 配对守恒`
      + `(当前 ${p.cols}×${p.rows}×${p.layers} 层;请减一层或改底面尺寸)`);
  }

  // 3. 元素配额(默认余数分配:前 rem 个元素各 +1 对;显式指定时严格校验)
  const totalPairs = slots.length / 2;
  let quotas: number[];
  if (spec.pairsPerElement !== undefined) {
    const pp: number = spec.pairsPerElement;
    if (spec.elements.length * pp !== totalPairs) {
      throw new Error(
        `配额不符:${spec.elements.length} 元素 × ${pp} 对`
        + ` ≠ ${totalPairs} 对`);
    }
    quotas = spec.elements.map(() => pp);
  } else {
    const base = Math.floor(totalPairs / spec.elements.length);
    const rem = totalPairs % spec.elements.length;
    quotas = spec.elements.map((_, i) => base + (i < rem ? 1 : 0));
  }

  // 4. 确定性随机源(seed LCG)
  const rng = spec.seed !== undefined ? lcg(spec.seed) : Math.random;

  // 5. 元素序列(按配额)洗牌
  const elementBag: ElementDef[] = [];
  spec.elements.forEach((e, i) => {
    for (let n = 0; n < quotas[i]; n++) elementBag.push(e);
  });
  fisherYates(elementBag, rng);

  // 6. 位置洗牌后两两成对(同对两半随机散布;更优的跨层分离策略留待可解性调优)
  const order = slots.map((_, i) => i);
  fisherYates(order, rng);

  const assignment = new Array<{ elementId: string; variant: 'L' | 'R' }>(slots.length);
  for (let pair = 0; pair < totalPairs; pair++) {
    const a = order[2 * pair];
    const b = order[2 * pair + 1];
    const elem = elementBag[pair].elementId;
    const swap = rng() < 0.5;
    assignment[a] = { elementId: elem, variant: swap ? 'R' : 'L' };
    assignment[b] = { elementId: elem, variant: swap ? 'L' : 'R' };
  }

  // 7. 组装(保持 slot 原始顺序 → 稳定 tileId = 数组下标)
  let maxGx = 0, maxGy = 0;
  const tiles: TileDef[] = slots.map((s, i): TileDef => ({
    elementId: assignment[i].elementId,
    variant: assignment[i].variant,
    gx: s.gx,
    gy: s.gy,
    layer: s.layer,
  }));
  for (const s of slots) {
    maxGx = Math.max(maxGx, s.gx);
    maxGy = Math.max(maxGy, s.gy);
  }

  const level: LevelData = {
    board: { w: maxGx + TILE.w, h: maxGy + TILE.h },
    elements: spec.elements,
    tiles,
  };

  // 8. 不变量自检(I1/I2/I4/I5)
  const violations = validateLevelData(level);
  if (violations.length > 0) {
    throw new Error('关卡自检失败:\n' + violations.join('\n'));
  }
  return level;
}

/** 便捷入口:规格 → 直接构建运行时牌桌 */
export function buildBoard(spec: LevelSpec): Board {
  return new Board(buildLevel(spec));
}

// ─────────────────────────── 不变量校验(LevelCodec 前身) ───────────────────────────

/** 校验 I1/I2/I4/I5;返回违规清单(空 = 通过) */
export function validateLevelData(level: LevelData): string[] {
  const errs: string[] = [];
  const elementIds = new Set(level.elements.map(e => e.elementId));

  // I2 引用完整
  for (const t of level.tiles) {
    if (!elementIds.has(t.elementId)) errs.push(`I2: elementId "${t.elementId}" 不在元素表`);
  }

  // I1 配对守恒
  const count = new Map<string, { L: number; R: number; FULL: number }>();
  for (const t of level.tiles) {
    const c = count.get(t.elementId) ?? { L: 0, R: 0, FULL: 0 };
    c[t.variant]++;
    count.set(t.elementId, c);
  }
  count.forEach((c, id) => {
    if (c.L !== c.R) errs.push(`I1: "${id}" L(${c.L}) ≠ R(${c.R})`);
    if (c.FULL % 2 !== 0) errs.push(`I1: "${id}" FULL(${c.FULL}) 为奇数`);
  });

  // I4 单位整数 + I5 区域边界
  for (const t of level.tiles) {
    if (!Number.isInteger(t.gx) || !Number.isInteger(t.gy) || t.gx < 0 || t.gy < 0) {
      errs.push(`I4: 牌(${t.elementId}/${t.variant}) 坐标非非负整数 (${t.gx},${t.gy})`);
    }
    if (!Number.isInteger(t.layer) || t.layer < 0) errs.push(`I4: layer 非非负整数 ${t.layer}`);
    if (t.gx + TILE.w > level.board.w || t.gy + TILE.h > level.board.h) {
      errs.push(`I5: 牌(${t.elementId}/${t.variant}) 顶面越界 (${t.gx},${t.gy})`);
    }
    if (t.gy < TILE.sideH) {
      errs.push(`I5: 牌(${t.elementId}/${t.variant}) gy(${t.gy}) < sideH,侧面越下界`);
    }
  }
  return errs;
}

// ─────────────────────────── 工具 ───────────────────────────

/** 线性同余随机源(确定性;LayoutGen 等共用) */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 洗牌(LayoutGen 等共用) */
export function fisherYates<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}
