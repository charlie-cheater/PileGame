// ============================================================================
// agent-iteration.test.js — 随机填充 × 代理迭代 批量验证与统计(node 直跑)
//
// 统一测试盘面:编辑器当前布局 assets/data/layouts/test_layout.json(70 张 = 35 对)
//
// 编译:
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Runner.ts --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/agent-iteration.test.js
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const { Board } = require('../temp/v3check/core/Board');
const { buildMahjongElements } = require('../temp/v3check/core/MahjongSet');
const { fillSlots, buildFilledLevel } = require('../temp/v3check/core/RandomFill');
const { runAgent, randomPolicy, greedyPairPolicy } = require('../temp/v3check/agent/Runner');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}

/** 编辑器布局骨架(test_layout.json,70 张 = 35 对) */
function layoutSlots() {
  return { slots: LAYOUT.tiles, board: LAYOUT.board };
}

/** 元素池生成器 */
const mkEls = (n) => Array.from({ length: n }, (_, i) =>
  ({ elementId: 'u' + (i + 1), displayName: '元素' + (i + 1), color: '#fff' }));

console.log('— 随机填充:确定性与不变量 —');
{
  const { slots, board } = layoutSlots();
  const els7 = mkEls(7);

  const a = fillSlots(slots, { elements: els7, pairsPerElement: 5, seed: 42 });
  const b = fillSlots(slots, { elements: els7, pairsPerElement: 5, seed: 42 });
  const c = fillSlots(slots, { elements: els7, pairsPerElement: 5, seed: 43 });
  check('同 seed 逐字节一致', JSON.stringify(a) === JSON.stringify(b));
  check('异 seed 分配不同', JSON.stringify(a) !== JSON.stringify(c));

  check('全部 FULL(全图匹配)', a.every(t => t.variant === 'FULL'));
  const counts = new Map();
  for (const t of a) counts.set(t.elementId, (counts.get(t.elementId) ?? 0) + 1);
  check('每元素恰 10 张(7 元素 × 5 对)', [...counts.values()].every(n => n === 10) && counts.size === 7);

  const level = buildFilledLevel(board, slots, { elements: els7, pairsPerElement: 5, seed: 42 });
  check('buildFilledLevel 通过 I1~I5 自检', level.tiles.length === 70);

  let threw = false;
  try { fillSlots(slots, { elements: els7, pairsPerElement: 4, seed: 1 }); }
  catch { threw = true; }
  check('配额不符即抛错', threw);
}

console.log('— 代理迭代:单局契约 —');
{
  const { slots, board } = layoutSlots();
  const els7 = mkEls(7);
  const level = buildFilledLevel(board, slots, { elements: els7, pairsPerElement: 5, seed: 42 });

  const r1 = runAgent(new Board(level), { seed: 7 });
  const r2 = runAgent(new Board(buildFilledLevel(board, slots, { elements: els7, pairsPerElement: 5, seed: 42 })), { seed: 7 });
  check('同 seed 同关卡可重放(逐步一致)',
    r1.steps.length === r2.steps.length &&
    r1.steps.every((s, i) => s.chosenTile === r2.steps[i].chosenTile));

  check(`终局合法(${r1.outcome},pick ${r1.picks},消除 ${r1.pairsEliminated} 对)`,
    ['cleared', 'slot_full', 'no_clickable'].includes(r1.outcome));
  check('轨迹步数 = 拾取数', r1.steps.length === r1.picks);
  check('槽压峰值 ≤ 4', r1.maxSlotPressure <= 4);
  check('全程可点性零冲突(v3 定理)', r1.clickConflicts === 0);
  check('每步决策前存在可点牌', r1.steps.every(s => s.clickable >= 1));
  check('每步后槽位 ≤ 4', r1.steps.every(s => s.slotAfter <= 4));
  if (r1.outcome === 'cleared') check('通关 = 消除 35 对', r1.pairsEliminated === 35);
}

console.log('— 批量迭代:随机语料统计(随机数据辅助求解器迭代)—');
{
  const { slots, board } = layoutSlots();
  const els35 = mkEls(35);   // 唯一伴偶:最难
  const els7 = mkEls(7);     // 7×5:可互换,宽容

  function batch(name, els, policy, N) {
    let cleared = 0, picks = 0, pressure = 0, pairs = 0;
    for (let i = 0; i < N; i++) {
      const level = buildFilledLevel(board, slots, { elements: els, seed: 1000 + i });
      const r = runAgent(new Board(level), { seed: 2000 + i, policy });
      if (r.outcome === 'cleared') cleared++;
      picks += r.picks; pressure += r.maxSlotPressure; pairs += r.pairsEliminated;
    }
    console.log(`    ${name} · 通关率 ${(cleared / N * 100).toFixed(1)}% · 平均 pick ${(picks / N).toFixed(1)}`
      + ` · 平均消除 ${(pairs / N).toFixed(1)} 对 · 平均槽压峰值 ${(pressure / N).toFixed(2)}`);
    return cleared;
  }

  const N = 150;
  const uniquePairs = batch('35 元素 × 1 对(唯一伴偶,最难)', els35, randomPolicy, N);
  const multi5 = batch(' 7 元素 × 5 对(可互换,宽容)  ', els7, randomPolicy, N);
  check('重复度效应可见:7×5 随机通关率 ≥ 35×1', multi5 >= uniquePairs,
    `${multi5} vs ${uniquePairs}`);

  const greedy = batch(' 7 元素 × 5 对 + 见对先拿策略 ', els7, greedyPairPolicy, 100);
  const rnd100 = (() => {
    let cleared = 0;
    for (let i = 0; i < 100; i++) {
      const level = buildFilledLevel(board, slots, { elements: els7, seed: 1000 + i });
      if (runAgent(new Board(level), { seed: 2000 + i }).outcome === 'cleared') cleared++;
    }
    return cleared;
  })();
  check('策略插拔生效:见对先拿 ≥ 纯随机(同语料)', greedy >= rnd100,
    `${greedy} vs ${rnd100}`);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
