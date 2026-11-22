// ============================================================================
// LayoutGen.ts — 随机堆叠布局生成器(位置骨架;不含配对)
// 设计确认:2026-11-19 —— 逐层撒布 + 支撑约束(策略 A)
// 版面约束(2026-11-19 第三轮指示,占据模型):
//   · board 视作 1×1 unit 格胞网格;牌摆放于整 unit 位置(gx ∈ [0, w-TILE.w],
//     gy ∈ [sideH, h-TILE.h],整数),统一层原点 (0, sideH)
//   · 占据模型:牌落位后占据其覆盖的全部格胞([gx,gx+w)×[gy,gy+h));
//     同层后续牌不得覆盖任何已占格胞 → 同层零重叠(贴边合法)
//   · 上层支撑约束不变(压住至少一张 k-1 层牌);错位/骑缝形态由
//     整格位置 + 支撑判定自然涌现
//
// 算法:每层在合法格点集内随机采样(蒙版过滤 + 支撑约束:必须压住至少一张
// k-1 层牌,复用 pressesOn 实质压迫谓词);层量显式 layerCounts 优先,缺省按衰减率分配。
// 失败策略(C6):撒不满/初始可点不足 → 换派生 seed 整体重试(≤5 次)。
// 输出 slots 自带 tileId(= 生成序);自检 C1(半格格点)/C2/C3/C5。
// ============================================================================

import { TILE, Unit } from './tile';
import { OcclusionSubject, pressesOn, faceRectOf, overlapArea } from './Occlusion';
import { computeDepths } from './Depth';
import { lcg, fisherYates } from './LevelBuilder';
import { checkTorque, ContactRect, rectIntersect } from './Statics';

export interface RandomLayoutConfig {
  board: { w: Unit; h: Unit };
  /** 目标牌数(counts 模式必填,偶数;capacity 模式忽略) */
  targetTiles?: number;
  /** 层数上限 */
  layers: number;
  /** 填充模式:counts = 按层量(counts/decay/layerCounts);capacity = 逐层填满为止 */
  fillMode?: 'counts' | 'capacity';
  /** 显式各层张量(优先;须单调不增、总和 = targetTiles、长度 ≤ layers) */
  layerCounts?: number[];
  /** 上层张量衰减率(layerCounts 缺省时生效,默认 0.6) */
  layerDecay?: number;
  /** 形态蒙版:rect 全域 / ellipse 内切椭圆(牌中心约束) */
  mask?: 'rect' | 'ellipse';
  /** 位置步长(整数 unit;默认 1×1 整格;饱和语义 = 步长格点集内放不下) */
  step?: { x: Unit; y: Unit };
  /** 验收:depth=0 初始可点牌数下限(默认 4) */
  minOpenTiles?: number;
  /** 力矩平衡约束(默认开启;底层落在桌面上恒平衡) */
  torque?: boolean;
  /** 刀刃放行的接触面积比阈值(严格大于才放行,默认 0.25) */
  torqueRazorArea?: number;
  /** 力矩策略:razor(默认,刀刃+面积门槛)/ strict(禁止刀刃,重心须严格在凸包内) */
  torqueMode?: 'razor' | 'strict';
  /** 允许满叠(与紧邻下层完全同位;默认 false = 禁止,仅查 k-1 层) */
  allowFullStack?: boolean;
  seed?: number;
}

export interface LayoutStats {
  /** 实际各层张量(下标 = 层) */
  layerCounts: number[];
  /** depth=0 的牌数(初始可点) */
  openTiles: number;
  maxDepth: number;
}

export interface LayoutResult {
  slots: OcclusionSubject[];
  stats: LayoutStats;
  /** computeDepths 波次(升序) */
  waves: number[][];
}

interface Placed { tiles: OcclusionSubject[][]; layerCounts: number[]; }

export function generateLayout(cfg: RandomLayoutConfig): LayoutResult {
  validateConfig(cfg);

  for (let attempt = 0; attempt < 5; attempt++) {
    const rng = lcg(((cfg.seed ?? 1) + attempt * 7919) >>> 0);
    // capacity 奇偶盲区对策:区域上 2×2 格块最大填装存在结构性奇偶不变量,
    // 换洗牌序不改变奇偶 → 逐次收缩蒙版半径 0.4% 改变区域形状以翻转奇偶
    const shrink = (cfg.fillMode ?? 'counts') === 'capacity' ? 1 - attempt * 0.004 : 1;
    const placed = tryGenerate(cfg, rng, shrink);
    if (!placed) continue;

    // 注:不用 Array.flat(ES2019)——编辑器编译目标不支持(node tsc es2020 测不出)
    const slots: OcclusionSubject[] = [];
    for (const layer of placed.tiles) {
      for (const t of layer) slots.push(t);
    }
    // capacity 模式:奇数张直接重试(弹牌裁剪会破坏饱和语义)
    if ((cfg.fillMode ?? 'counts') === 'capacity' && slots.length % 2 !== 0) continue;
    const report = computeDepths(slots);
    const openTiles = report.waves[0]?.length ?? 0;
    if (openTiles < (cfg.minOpenTiles ?? 4)) continue;   // 可玩性验收失败 → 重试

    assertInvariants(cfg, slots);
    return {
      slots,
      stats: { layerCounts: placed.layerCounts, openTiles, maxDepth: report.maxDepth },
      waves: report.waves,
    };
  }
  throw new Error(
    `随机布局生成失败(5 次尝试):请放宽 board/targetTiles/layerCounts/sameLayerGap 配置`);
}

// ─────────────────────────── 生成 ───────────────────────────

function tryGenerate(cfg: RandomLayoutConfig, rng: () => number, maskShrink = 1): Placed | null {
  const capacity = (cfg.fillMode ?? 'counts') === 'capacity';
  const counts = capacity
    ? null
    : (cfg.layerCounts ? [...cfg.layerCounts] : distributeCounts(cfg.targetTiles!, cfg.layers, cfg.layerDecay ?? 0.6));

  const tiles: OcclusionSubject[][] = Array.from({ length: cfg.layers }, () => []);
  let nextId = 0;

  for (let k = 0; k < cfg.layers; k++) {
    if (!capacity && counts![k] <= 0) continue;
    if (k > 0 && tiles[k - 1].length === 0) {
      if (capacity) break;      // 无支撑层可依 → 后续层也无法填,自然停止
      return null;
    }

    const maxGx = cfg.board.w - TILE.w;
    const maxGy = cfg.board.h - TILE.h;
    if (maxGx < 0 || maxGy < TILE.sideH) return null;
    const stepX = cfg.step?.x ?? 1;
    const stepY = cfg.step?.y ?? 1;
    const maxCol = Math.floor((maxGx - 0) / stepX);
    const maxRow = Math.floor((maxGy - TILE.sideH) / stepY);

    const occupiedCells = new Set<string>();
    const cellsFree = (gx: number, gy: number): boolean => {
      for (let x = gx; x < gx + TILE.w; x++) {
        for (let y = gy; y < gy + TILE.h; y++) {
          if (occupiedCells.has(`${x},${y}`)) return false;
        }
      }
      return true;
    };
    const place = (gx: number, gy: number): void => {
      for (let x = gx; x < gx + TILE.w; x++) {
        for (let y = gy; y < gy + TILE.h; y++) occupiedCells.add(`${x},${y}`);
      }
      tiles[k].push({ tileId: nextId++, gx, gy, layer: k });
    };
    const canPlace = (gx: number, gy: number): boolean => {
      if (!cellsFree(gx, gy)) return false;
      // 禁止满叠:与紧邻下层(k-1)牌完全同位即拒(2026-11-20 修正:
      // 原实现跨层查到底层属过度解读;隔层同位 + 桥接支撑是合法形态)
      if (!cfg.allowFullStack && k > 0) {
        if (tiles[k - 1].some(t => t.gx === gx && t.gy === gy)) return false;
      }
      if (k > 0) {
        const cand: OcclusionSubject = { tileId: -1, gx, gy, layer: k };
        // 支撑 = 实质压迫(pressesOn,v2.2 级单对语义;blocked 的 v3 并集
        // 口径不适用于"压在哪张上"的单对判定)
        if (!tiles[k - 1].some(t => pressesOn(cand, t))) return false;
        // 力矩平衡:与紧邻下层的接触矩形 → 支撑凸包 + 刀刃面积门槛
        if (cfg.torque !== false) {
          const contacts: ContactRect[] = [];
          for (const t of tiles[k - 1]) {
            const r = rectIntersect(gx, gy, TILE.w, TILE.h, t.gx, t.gy, TILE.w, TILE.h);
            if (r) contacts.push(r);
          }
          const res = checkTorque(gx + TILE.w / 2, gy + TILE.h / 2,
            contacts, cfg.torqueRazorArea ?? 0.25, cfg.torqueMode ?? 'razor');
          if (!res.ok) return false;
        }
      }
      return true;
    };

    if (capacity) {
      // 洗牌贪心单遍:被跳过的位置只会更非法 → 单遍即达饱和(最大填装)
      const positions: Array<[number, number]> = [];
      for (let col = 0; col <= maxCol; col++) {
        for (let row = 0; row <= maxRow; row++) {
          const gx = col * stepX;
          const gy = TILE.sideH + row * stepY;
          if (inMask(gx, gy, cfg, maskShrink)) positions.push([gx, gy]);
        }
      }
      fisherYates(positions, rng);
      for (const [gx, gy] of positions) {
        if (canPlace(gx, gy)) place(gx, gy);
      }
      if (tiles[k].length === 0) return null;              // 一张都放不下
    } else {
      const want = counts![k];
      let tries = 0;
      const maxTries = want * 400;
      while (tiles[k].length < want && tries < maxTries) {
        tries++;
        const gx = Math.floor(rng() * (maxCol + 1)) * stepX;
        const gy = TILE.sideH + Math.floor(rng() * (maxRow + 1)) * stepY;
        if (!inMask(gx, gy, cfg, maskShrink)) continue;
        if (canPlace(gx, gy)) place(gx, gy);
      }
      if (tiles[k].length < want) return null;             // 撒不满 → 整体重试
    }
  }

  // capacity:奇偶交由外层重试保证(弹牌会破坏饱和),此处不做裁剪
  return { tiles, layerCounts: tiles.map(a => a.length) };
}

/** 牌中心是否在蒙版内(maskShrink:椭圆半径缩放,奇偶盲区对策) */
function inMask(gx: number, gy: number, cfg: RandomLayoutConfig, maskShrink = 1): boolean {
  const cx = gx + TILE.w / 2 - cfg.board.w / 2;
  const cy = gy + TILE.h / 2 - cfg.board.h / 2;
  if ((cfg.mask ?? 'rect') === 'rect') return true;
  const rx = ((cfg.board.w - TILE.w) / 2) * maskShrink;
  const ry = ((cfg.board.h - TILE.h) / 2) * maskShrink;
  return (cx * cx) / (rx * rx) + (cy * cy) / (ry * ry) <= 1;
}

/** 比例分配层量:最大余数法 + 单调不减修正(总和守恒) */
function distributeCounts(target: number, layers: number, decay: number): number[] {
  const w: number[] = [];
  for (let k = 0; k < layers; k++) w.push(Math.pow(decay, k));
  const W = w.reduce((a, b) => a + b, 0);
  const raw = w.map(x => (target * x) / W);
  const K = raw.map(Math.floor);
  let rem = target - K.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f || a.i - b.i);
  for (let j = 0; rem > 0; j++, rem--) K[byFrac[j % byFrac.length].i]++;
  for (let k = 1; k < layers; k++) {
    if (K[k] > K[k - 1]) { K[0] += K[k] - K[k - 1]; K[k] = K[k - 1]; }
  }
  return K;
}

// ─────────────────────────── 校验 ───────────────────────────

function validateConfig(cfg: RandomLayoutConfig): void {
  if (cfg.layers < 1) throw new Error(`layers 须 ≥ 1`);
  if (cfg.board.w < TILE.w || cfg.board.h < TILE.h + TILE.sideH) {
    throw new Error(`board ${cfg.board.w}×${cfg.board.h} 容不下单张牌`);
  }
  if ((cfg.fillMode ?? 'counts') === 'capacity') return;   // 张数涌现,无需 targetTiles

  if (cfg.targetTiles === undefined || cfg.targetTiles < 2 || cfg.targetTiles % 2 !== 0) {
    throw new Error(`targetTiles 须为 ≥2 的偶数(I1 前置),当前 ${cfg.targetTiles}`);
  }
  if (cfg.layerCounts) {
    const lc = cfg.layerCounts;
    if (lc.length > cfg.layers) throw new Error(`layerCounts 长度(${lc.length})超过 layers(${cfg.layers})`);
    const sum = lc.reduce((a, b) => a + b, 0);
    if (sum !== cfg.targetTiles) {
      throw new Error(`layerCounts 总和(${sum})≠ targetTiles(${cfg.targetTiles})`);
    }
    for (let k = 1; k < lc.length; k++) {
      if (lc[k] > lc[k - 1]) throw new Error(`layerCounts 须单调不增(违反于第 ${k} 层)`);
    }
  }
}

/** 生成后全量断言(C1 整格/C2/C3) */
function assertInvariants(cfg: RandomLayoutConfig, slots: OcclusionSubject[]): void {
  if (slots.length % 2 !== 0) throw new Error('C2: 牌数为奇数');
  for (const s of slots) {
    if (!Number.isInteger(s.gx) || !Number.isInteger(s.gy) || s.gx < 0 || s.gy < TILE.sideH) {
      throw new Error(`C1: 坐标非法 (${s.gx},${s.gy})`);
    }
    if (s.gx + TILE.w > cfg.board.w || s.gy + TILE.h > cfg.board.h) {
      throw new Error(`C1: 出界 (${s.gx},${s.gy})`);
    }
    if (s.layer > 0) {
      const supported = slots.some(t =>
        t.layer === s.layer - 1 && pressesOn(s, t));
      if (!supported) throw new Error(`C3: 层 ${s.layer} 牌(${s.gx},${s.gy})悬空`);
    }
  }
}
