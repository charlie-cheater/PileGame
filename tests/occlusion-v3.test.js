// ============================================================================
// occlusion-v3.test.js — v3 并集口径回归测试(node 直跑,不依赖 cc)
//
// 运行前需将 core 编译到 temp/v3check(纯逻辑层无 cc 依赖):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Ladder.ts assets/scripts/agent/Runner.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/occlusion-v3.test.js
// ============================================================================

const { TILE } = require('../temp/v3check/core/tile');
const { computeOcclusion, coversAny, pressesOn, unionArea,
  buildOcclusionIndex, blockedAfter, deriveOcclusion } = require('../temp/v3check/core/Occlusion');
const { computeVisibleState } = require('../temp/v3check/core/Visibility');
const { computeDepths } = require('../temp/v3check/core/Depth');
const { Board } = require('../temp/v3check/core/Board');
const { generateLayout } = require('../temp/v3check/core/LayoutGen');
const { fillSlots } = require('../temp/v3check/core/RandomFill');
const { buildMahjongElements } = require('../temp/v3check/core/MahjongSet');
const LAYOUT = require('../assets/data/layouts/test_layout.json');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}

/** 构造最小 Tile(纯逻辑测试用) */
function mk(tileId, gx, gy, layer) {
  return { elementId: 'x', variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null };
}

console.log('— Case A:v2.2 漏判形态(三张小覆盖拼 32.5%,每张单独 ≤12.5% 且无侧边擦及)—');
{
  const t = mk(0, 0, 10, 0);
  const A = mk(1, -7, 10, 1);   // 左缘竖条 1×10 = 12.5%
  const B = mk(2, 7, 10, 1);    // 右缘竖条 12.5%
  const C = mk(3, 0, 1, 1);     // 下缘横带 8×1 = 10%
  const d = computeOcclusion([t, A, B, C]);
  check('单对均不构成实质压迫(v2.2 语义下确不挡 → 旧口径漏判)',
    !pressesOn(A, t) && !pressesOn(B, t) && !pressesOn(C, t));
  check('v3 并集 32.5% > 18% → blocked', d.get(0).blocked === true);
  check('clickable = false', d.get(0).clickable === false);
  const vis = computeVisibleState([t, A, B, C]);
  check('暴露面积 = 80 − 26 = 54(unit²)', vis.byTile.get(0).exposedArea === 54,
    `actual ${vis.byTile.get(0).exposedArea}`);
  check('遮挡者不受 t 压迫', !d.get(1).blocked && !d.get(2).blocked && !d.get(3).blocked);
}

console.log('— Case B:单张大覆盖(75%)—');
{
  const t = mk(0, 0, 10, 0), o = mk(1, 2, 10, 1);
  const d = computeOcclusion([t, o]);
  check('blocked(两口径均挡)', d.get(0).blocked === true);
  check('pressesOn 实质压迫', pressesOn(o, t) === true);
}

console.log('— Case C:仅跨层侧边擦及(并集 10% ≤ 阈值)—');
{
  const t = mk(0, 0, 10, 0), o = mk(1, 7, 12, 1);
  const d = computeOcclusion([t, o]);
  check('侧边免阈条款 → blocked', d.get(0).blocked === true);
}

console.log('— Case D:单张 12.5% 覆盖、无侧边擦及 —');
{
  const t = mk(0, 0, 10, 0), o = mk(1, 7, 10, 1);
  const d = computeOcclusion([t, o]);
  check('并集 ≤ 阈值 → 不挡、可点', d.get(0).clickable === true);
  const vis = computeVisibleState([t, o]);
  check('暴露面积 70', vis.byTile.get(0).exposedArea === 70);
  check('coversAny 有边(深度结构计入)', coversAny(o, t) === true);
}

console.log('— Case E:编辑器布局冒烟(test_layout.json,70 张,填充 seed 7)—');
{
  const elements = buildMahjongElements();
  const level = {
    board: LAYOUT.board,
    elements,
    tiles: fillSlots(LAYOUT.tiles, { elements, seed: 7 }),
  };
  const board = new Board(level);
  const TOTAL = level.tiles.length;
  const click0 = board.clickableTiles().length;
  check('初始可点 > 0', click0 > 0, `actual ${click0}`);

  const rep = computeDepths(board.allTiles());
  const wave0ok = rep.waves[0].every(id => board.getDerived(id).clickable);
  check('depth=0 波次全部可点(v3 一致性恢复)', wave0ok);

  // 配对感知贪心冒烟:双亮对优先 → 互补入槽次之 → 持有"伴暴露度最高"的单张
  let picked = 0, eliminatedPairs = 0, result = 'stalled';
  const canPair = (a, b) => a.elementId === b.elementId;
  for (let step = 0; step < 2000; step++) {
    if (board.isCleared()) { result = 'cleared'; break; }
    const cs = board.clickableTiles();
    if (cs.length === 0) { result = 'no_clickable'; break; }
    const inSlot = board.slotTiles();
    let target = null;
    // ① 双亮对(先取 a,补 b 即消除)
    outer: for (const a of cs) for (const b of cs) {
      if (a.tileId !== b.tileId && canPair(a, b)) { target = a.tileId; break outer; }
    }
    // ② 互补槽内(取了立即成对)
    if (target === null) for (const a of cs) for (const s of inSlot) {
      if (canPair(a, s)) { target = a.tileId; break; }
    }
    // ③ 持有伴暴露度最高的单张(伴越亮,占槽时间越短)
    if (target === null) {
      const vis = board.getVisibleState();
      let best = -1;
      for (const a of cs) {
        const mate = board.allTiles().find(t => t.tileId !== a.tileId && canPair(t, a) && t.status === 'pile');
        const score = mate ? (vis.byTile.get(mate.tileId)?.exposedRatio ?? -1) : -1;
        if (score > best) { best = score; target = a.tileId; }
      }
    }
    const r = board.pick(target);
    if (!r.ok) { result = `pick_failed(${r.reason})`; break; }
    picked++;
    if (r.paired) {
      if (board.eliminate(r.paired[0], r.paired[1])) eliminatedPairs++;
      board.compactSlots();
    }
    if (board.isSlotFull() && !board.findSlotPair()) { result = 'slot_full'; break; }
  }
  const consv = board.allTiles().filter(t => t.status === 'eliminated').length
    + board.slotCount() + board.pileCount() === TOTAL;
  console.log(`    配对感知贪心:${result},pick ${picked} 次,消除 ${eliminatedPairs} 对`);
  check(`状态守恒(消除+槽+堆 = ${TOTAL})`, consv);
  check('规则一致(通关或槽满判负,无异常中间态)', result === 'cleared' || result === 'slot_full');

  // LayoutGen 冒烟(支撑谓词 pressesOn 生效)
  const lay = generateLayout({ board: { w: 88, h: 80 }, layers: 4, fillMode: 'capacity', step: { x: 4, y: 5 }, seed: 7 });
  check(`LayoutGen capacity 正常(共 ${lay.slots.length} 张,开局可点 ${lay.stats.openTiles})`,
    lay.slots.length > 0 && lay.stats.openTiles >= 4 && lay.slots.length % 2 === 0);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);

// ============================================================================
// 等价性回归(2026-11-24,消除模拟提速·方案甲):遮挡关系索引法 ⇔ 全盘重算。
// 提速不改变任何规则,只改变计算方式——以下断言保证「计算方式」没有改变结果。
// 被测:buildOcclusionIndex / deriveOcclusion / blockedAfter;参照:computeOcclusion。
// ============================================================================
const { perceive } = require('../temp/v3check/agent/Perception');
const { analyze } = require('../temp/v3check/agent/Analysis');
const { decideByLadder, defaultLadder } = require('../temp/v3check/agent/Ladder');
const { lcg, fisherYates } = require('../temp/v3check/core/LevelBuilder');

console.log('— 等价性回归:遮挡关系索引法 ⇔ 全盘重算 —');
{
  const mkEls = n => Array.from({ length: n }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: 'e', color: '#fff' }));
  // 用默认梯跑真实对局,沿途收集每个阶段的感知集——必须覆盖到残局的小盘面
  const boards = [];
  for (const n of [7, 14, 35]) for (let seed = 0; seed < 4; seed++) {
    const els = mkEls(n);
    const b = new Board({ board: LAYOUT.board, elements: els, tiles: fillSlots(LAYOUT.tiles, { elements: els, seed: 1000 + seed }) });
    for (let step = 0; step < 300; step++) {
      if (b.isCleared()) break;
      const view = perceive(b);
      if (view.perceived.length === 0) break;
      boards.push(view.perceived.map(t => ({ ...t })));
      const a = analyze(view);
      const click = view.perceived.filter(t => a.derived.get(t.tileId).clickable);
      if (click.length === 0) break;
      const op = decideByLadder(defaultLadder, { view, analysis: a, clickable: click, rng: lcg(2000 + seed + step) });
      const r = b.pick(op.action.tileId); if (!r.ok) break;
      if (r.paired) { b.eliminate(r.paired[0], r.paired[1]); b.compactSlots(); }
      if (b.isSlotFull() && !b.findSlotPair()) break;
    }
  }
  const S = { tested: 0, tiles: 0, badDerived: 0, sets: 0, badSet: 0, seqSteps: 0, badSeq: 0, sizes: {} };
  boards.forEach((tiles, bi) => {
    if (bi % 3 !== 0) return;                      // 每 3 个盘面取 1 个:全程各阶段均匀抽样
    S.tested++; S.tiles += tiles.length;
    const k = tiles.length < 10 ? '<10' : tiles.length < 25 ? '10~24' : tiles.length < 40 ? '25~39' : '40+';
    S.sizes[k] = (S.sizes[k] || 0) + 1;
    const index = buildOcclusionIndex(tiles);

    // ① 移除集为空:由索引得出的派生态 === computeOcclusion(逐牌比 blocked 与 clickable)
    const viaIndex = deriveOcclusion(index, tiles);
    const full = computeOcclusion(tiles);
    for (const t of tiles) {
      const x = viaIndex.get(t.tileId), y = full.get(t.tileId);
      if (x.blocked !== y.blocked || x.clickable !== y.clickable) S.badDerived++;
    }

    // ② 任意移除集(密度 0~1):blockedAfter === computeOcclusion(剩余牌).blocked
    for (let trial = 0; trial < 6; trial++) {
      const rng = lcg(trial * 7919 + tiles.length * 31 + bi);
      const removed = new Set(tiles.filter(() => rng() < trial / 5).map(t => t.tileId));
      S.sets++;
      const truth = computeOcclusion(tiles.filter(t => !removed.has(t.tileId)));
      for (const t of tiles) {
        if (removed.has(t.tileId)) continue;
        if (blockedAfter(index, t.tileId, removed) !== truth.get(t.tileId).blocked) S.badSet++;
      }
    }

    // ③ 逐步移除(消除模拟的拿牌方式):每移除一张就逐牌比较
    const order = tiles.map(t => t.tileId);
    fisherYates(order, lcg(bi * 104729 + tiles.length));
    const removed = new Set();
    for (const x of order) {
      removed.add(x); S.seqSteps++;
      const truth = computeOcclusion(tiles.filter(t => !removed.has(t.tileId)));
      for (const t of tiles) {
        if (removed.has(t.tileId)) continue;
        if (blockedAfter(index, t.tileId, removed) !== truth.get(t.tileId).blocked) S.badSeq++;
      }
    }
  });
  console.log(`    样本:${S.tested} 个盘面、${S.tiles} 张次(张数分布 ${JSON.stringify(S.sizes)});`
    + `逐牌比较 ${S.sets} 组任意移除集 + ${S.seqSteps} 步逐步移除`);
  check('移除集为空:由索引得出的派生态与 computeOcclusion 逐牌一致', S.badDerived === 0, `不一致 ${S.badDerived}`);
  check('任意移除集:索引法被压判定与全盘重算逐牌一致', S.badSet === 0, `不一致 ${S.badSet}`);
  check('逐步移除(模拟式拿牌):索引法被压判定与全盘重算逐牌一致', S.badSeq === 0, `不一致 ${S.badSeq}`);
  check('样本覆盖各阶段(含 10 张以下的残局与 40 张以上的开局)',
    (S.sizes['<10'] || 0) > 0 && (S.sizes['40+'] || 0) > 0, JSON.stringify(S.sizes));
  check('buildOcclusionIndex 拒绝非堆上的牌(输入须全为 pile)', (() => {
    try {
      buildOcclusionIndex([{ elementId: 'x', variant: 'FULL', gx: 0, gy: 2, layer: 0, tileId: 0, status: 'slot', slotIndex: 0 }]);
      return false;
    } catch (e) { return /不在堆上/.test(e.message); }
  })());
}

console.log(`\n合计(含等价性回归):${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
