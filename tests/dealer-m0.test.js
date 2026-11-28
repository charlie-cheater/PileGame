// ============================================================================
// dealer-m0.test.js — 布局器 M0 回归:渐进定型的守卫、奇偶账与成品一致性(node 直跑)
//
// 布局器(assets/scripts/planner/TypeDealer.ts)= 给定空间布局上的渐进式类型填充:
// 代理看见一张牌,布局器才给它定图案。本套测试钉住 M0 的验收口径:
//   · 未定型的牌不可点、定型即冻结(Board.assignType / pick 守卫)
//   · 可行规则:未定型张数全程 ≥ 开着的图案数(每盘最小余量 ≥ 0)
//   · 成品合法:validateLevelData 通过(每种图案偶数张、无占位符残留)
//   · 成品重放一致:成品重新加载、同种子、不带布局器再玩一遍,逐手与构建时相同
//   · 可复现:同种子成品逐字节一致
// 不注入布局器时 Runner 与改动前逐字节一致——由既有各套测试作站网,此处不重复。
//
// 编译:
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Ladder.ts assets/scripts/agent/Runner.ts \
//     assets/scripts/planner/TypeDealer.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/dealer-m0.test.js
//
// 可选:设环境变量 PILEGAME_TEST_TREE=<temp 下的编译树名> 可换一棵树跑(变异检查用)。
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const path = require('path');
const TREE = process.env.PILEGAME_TEST_TREE || 'v3check';
const root = name => require(path.join(__dirname, '..', 'temp', TREE, name));
const { Board } = root('core/Board');
const { validateLevelData } = root('core/LevelBuilder');
const { isUnassigned, unassignedElementId } = root('core/tile');
const { runAgent } = root('agent/Runner');
const { ladderPolicy } = root('agent/Ladder');
const { TypeDealer, blankLevel, dealProgressively } = root('planner/TypeDealer');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}

const mkEls = n => Array.from({ length: n }, (_, i) =>
  ({ elementId: 'u' + (i + 1), displayName: '元素' + (i + 1), color: '#fff' }));
const POOL3 = mkEls(3);
/** 执行 fn,返回抛出的错误信息(未抛 = 空串) */
const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
const unassignedLeft = level => level.tiles.filter(t => isUnassigned(t.elementId)).length;
const sumDealt = run => run.steps.reduce((a, s) => a + (s.dealt ?? 0), 0);

console.log('— 占位符与守卫(单点)—');
{
  check('占位符:各不相同,识别正确',
    isUnassigned(unassignedElementId(7)) && unassignedElementId(7) !== unassignedElementId(8)
    && !isUnassigned('u1') && !isUnassigned('?'));
  const blank = blankLevel(LAYOUT, POOL3);
  check('空白关卡:70 张全部未定型;校验报错(成品里残留占位符会被终检抓住)',
    blank.tiles.length === 70 && unassignedLeft(blank) === 70 && validateLevelData(blank).length > 0);

  const b = new Board(blank);
  const c = b.clickableTiles()[0];
  check('未定型的牌不可点:pick 抛错,槽不变',
    throws(() => b.pick(c.tileId)).includes('尚未定型') && b.slotCount() === 0);
  const derivedBefore = JSON.stringify(b.getDerived(c.tileId));
  const visBefore = JSON.stringify([...b.getVisibleState().byTile].map(([k, v]) => [k, v.exposedArea, v.exposedRatio]));
  b.assignType(c.tileId, 'u1');
  check('定型只改类型:派生态与可见性逐值不变',
    JSON.stringify(b.getDerived(c.tileId)) === derivedBefore
    && JSON.stringify([...b.getVisibleState().byTile].map(([k, v]) => [k, v.exposedArea, v.exposedRatio])) === visBefore
    && b.getTile(c.tileId).elementId === 'u1');
  check('定型即冻结:再定型抛错', throws(() => b.assignType(c.tileId, 'u2')).includes('已定型'));
  const other = b.clickableTiles()[1];
  check('新类型不能是占位符(该牌仍未定型)',
    throws(() => b.assignType(other.tileId, unassignedElementId(99))).includes('占位符')
    && isUnassigned(b.getTile(other.tileId).elementId));
  const r = b.pick(c.tileId);
  check('入槽的牌不能再定型', r.ok && throws(() => b.assignType(c.tileId, 'u1')).includes('不在牌堆'));
}

console.log('— 局终收尾(单点)—');
{
  const b = new Board(blankLevel(LAYOUT, POOL3));
  const d = new TypeDealer({ pool: POOL3, seed: 5 });
  const ids = b.allTiles().map(t => t.tileId);
  b.assignType(ids[0], 'u1');                                                   // u1 开着(1 张)
  b.assignType(ids[1], 'u2'); b.assignType(ids[2], 'u2'); b.assignType(ids[3], 'u2');   // u2 开着(3 张)
  const n = d.finish(b);
  const lv = d.toLevel(b);
  const counts = {};
  for (const t of lv.tiles) counts[t.elementId] = (counts[t.elementId] ?? 0) + 1;
  check('开着的图案各配到一张伴,其余两两成对:全部偶数、校验通过',
    n === 66 && validateLevelData(lv).length === 0 && counts.u1 >= 2 && counts.u2 >= 4
    && Object.values(counts).every(c => c % 2 === 0));
}

for (const tier of [14, 23]) {
  console.log(`— ${tier} 图案池 × 20 局 —`);
  const pool = mkEls(tier);
  let okValidate = true, okMargin = true, okTyped = true, okReplay = true, cleared = 0;
  let detail = '';
  for (let i = 0; i < 20; i++) {
    const res = dealProgressively(LAYOUT, { pool, seed: 1000 + i, agent: { seed: 2000 + i } });
    const st = res.dealer.stats;
    const v = validateLevelData(res.level);
    if (v.length) { okValidate = false; detail += ` [局${i} ${v[0]}]`; }
    if (!(st.minMargin >= 0) || st.opening !== 40) { okMargin = false; detail += ` [局${i} 余量 ${st.minMargin} 开局批 ${st.opening}]`; }
    if (st.typed !== 70 || sumDealt(res.run) + st.finished !== 70 || unassignedLeft(res.level) !== 0
      || (res.run.outcome === 'cleared' && st.finished !== 0)) {
      okTyped = false; detail += ` [局${i} typed ${st.typed} 收尾 ${st.finished}]`;
    }
    if (res.run.outcome === 'cleared') cleared++;
    const again = runAgent(new Board(JSON.parse(JSON.stringify(res.level))), { seed: 2000 + i, decision: ladderPolicy() });
    const same = again.outcome === res.run.outcome && again.picks === res.run.picks
      && again.steps.every((s, k) => s.chosenTile === res.run.steps[k].chosenTile)
      && again.steps.every(s => !('dealt' in s));
    if (!same) { okReplay = false; detail += ` [局${i} 重放 ${again.outcome}/${again.picks} ≠ ${res.run.outcome}/${res.run.picks}]`; }
  }
  check('成品合法:validateLevelData 通过,无占位符残留', okValidate, detail);
  check('可行规则:全程最小余量 ≥ 0;开局批 = 40(test_layout 开局感知集)', okMargin, detail);
  check('定型账目:过程中定型 + 收尾 = 70;通关局收尾补 0 张', okTyped, detail);
  check('成品重放一致:同种子、不带布局器,逐手相同;轨迹无 dealt 字段', okReplay, detail);
  console.log(`  (清盘 ${cleared}/20,供参考)`);
}

console.log('— 轨迹观测字段与可复现 —');
{
  const pool = mkEls(14);
  const res = dealProgressively(LAYOUT, { pool, seed: 1000, agent: { seed: 2000 } });
  const st = res.dealer.stats;
  check('轨迹 dealt:首步 = 开局批;有定型的步数 = 事件数;合计 = 过程中定型的张数',
    res.run.steps[0].dealt === st.opening
    && res.run.steps.filter(s => (s.dealt ?? 0) > 0).length === st.events
    && sumDealt(res.run) === st.typed - st.finished
    && st.batches.reduce((a, n) => a + n, 0) === st.typed - st.finished);
  const again = dealProgressively(LAYOUT, { pool, seed: 1000, agent: { seed: 2000 } });
  const other = dealProgressively(LAYOUT, { pool, seed: 1001, agent: { seed: 2000 } });
  check('同种子成品逐字节一致',
    JSON.stringify(res.level) === JSON.stringify(again.level)
    && JSON.stringify(st.batches) === JSON.stringify(again.dealer.stats.batches));
  check('异发牌种子成品不同', JSON.stringify(res.level) !== JSON.stringify(other.level));
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
