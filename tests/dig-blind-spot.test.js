// ============================================================================
// dig-blind-spot.test.js — dig 致死决策点回归集(2026-11-26 固化,node 直跑,不依赖 cc)
//
// 背景:归因发现 18 个「推进效能盲区」决策点——dig 梯在空槽 1 时于两条零裕量
// 路线间选了推进效能更高的,而那条线被穷举证明不可解;正确着(效能更低,在同梯
// 候选内)才是赢线。生成器:temp/gen-dig-blind-spot-fixture.js;尸检探针:
// temp/probe-dig-autopsy.js(均未入库,结论见会话记录)。
//
// 本测试固化两件事:
//   1. 不变量(必须恒真,与 advanceOf 的实现无关):
//      · 前缀逐手合法;
//      · P(prefix) 可解(solver= solved);
//      · P(prefix)+fatalPick 证明不可解(空间穷尽,nodes < 预算);
//      · 见证首手 = correctTile;致命牌在见证中更晚出现。
//   2. 基线量(随 advanceOf / 排序的改动人工下修):盲点数 = advanceOf(致命牌)
//      > advanceOf(正确着) 的个数,当前 18/18。
//      若此数下降 = 改进生效,请人工核对后更新基线 18;上升 = 退化。
//
// 数据:tests/dig-blind-spot-fixture.json(18 个决策点;前缀为已记录的合法拿牌线,
// 与梯的未来行为解耦)。
// ============================================================================

const path = require('path');
const { Board } = require(path.join(__dirname, '..', 'temp', 'v3check', 'core', 'Board'));
const { buildOcclusionIndex } = require(path.join(__dirname, '..', 'temp', 'v3check', 'core', 'Occlusion'));
const { solvePile } = require(path.join(__dirname, '..', 'temp', 'v3check', 'core', 'PileSolver'));
const { buildFilledLevel } = require(path.join(__dirname, '..', 'temp', 'v3check', 'core', 'RandomFill'));
const { ladderPolicy, advanceOf } = require(path.join(__dirname, '..', 'temp', 'v3check', 'agent', 'Ladder'));
const { runAgent } = require(path.join(__dirname, '..', 'temp', 'v3check', 'agent', 'Runner'));
const { perceive } = require(path.join(__dirname, '..', 'temp', 'v3check', 'agent', 'Perception'));
const { analyze } = require(path.join(__dirname, '..', 'temp', 'v3check', 'agent', 'Analysis'));
const LAYOUT = require(path.join(__dirname, '..', 'assets', 'data', 'layouts', 'test_layout.json'));
const FIXTURE = require('./dig-blind-spot-fixture.json');

const MAX_NODES = 2000000;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + '  ' + (detail ?? '')); }
}

const lvCache = new Map();
function levelOf(tier, seed) {
  const k = tier + '-' + seed;
  if (!lvCache.has(k)) {
    const els = Array.from({ length: tier }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
    lvCache.set(k, buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed }));
  }
  return lvCache.get(k);
}

console.log('— dig 盲点回归集:推进效能盲区的 18 个已证明致死决策点 —');
let anomalies = 0;
let checked = 0;
let blindSpots = 0;
for (const c of FIXTURE.cases) {
  const level = levelOf(c.tier, c.seed);
  const b = new Board(level);
  const anomaly = [];
  // 前缀逐手重放(合法性不变量)
  for (const t of c.prefix) {
    const p = b.pick(t);
    if (!p.ok) { anomaly.push('前缀手 ' + t + ' 被拒(' + p.reason + ')'); break; }
    if (p.paired) { b.eliminate(p.paired[0], p.paired[1]); b.compactSlots(); }
  }
  if (anomaly.length === 0) {
    checked++;
    const tiles = new Board(level).allTiles();
    const index = buildOcclusionIndex(tiles);
    const removed = new Set(c.prefix);
    const pre = solvePile(tiles, { initialRemoved: removed, index, maxNodes: MAX_NODES });
    if (pre.status !== 'solved') anomaly.push('P(prefix) = ' + pre.status + '(应可解)');
    const after = solvePile(tiles, { initialRemoved: new Set([...removed, c.fatalPick]), index, maxNodes: MAX_NODES });
    if (!(after.status === 'unknown' && after.nodes < MAX_NODES)) {
      anomaly.push('P+fatal 判定 ' + after.status + '/nodes ' + after.nodes + '(应为空间穷尽的证明不可解)');
    }
    // 见证首手 = correctTile;致命牌在见证中更晚出现
    const wit = solvePile(tiles, { initialRemoved: removed, index, maxNodes: MAX_NODES }).witness;
    if (wit[0] !== c.correctTile) anomaly.push('见证首手 ' + wit[0] + ' ≠ correctTile ' + c.correctTile);
    const wIdx = wit.indexOf(c.fatalPick);
    if (!(wIdx > 0)) anomaly.push('致命牌 ' + c.fatalPick + ' 不在见证中或位置异常(' + wIdx + ')');
    // 基线量:盲点判定(决策时刻的推进效能)。若此数变化,见本文件头部说明。
    const ctxView = perceive(b);
    const ctxAnalysis = analyze(ctxView);
    const ctx = { view: ctxView, analysis: ctxAnalysis,
      clickable: ctxView.perceived.filter(t => ctxAnalysis.derived.get(t.tileId)?.clickable === true), rng: () => 0.42 };
    const advFatal = advanceOf(c.fatalPick, ctx).total;
    const advCorrect = advanceOf(c.correctTile, ctx).total;
    if (advFatal > advCorrect) blindSpots++;
    else console.error('  · 盲点消失(advanceOf 改进生效?): 盘 ' + c.seed + ' 致命 ' + advFatal.toFixed(3) + ' ≤ 正确 ' + advCorrect.toFixed(3) + '——请人工核对后下修基线 18');
    if (anomaly.length > 0) fail++; else pass++;
  }
  if (anomaly.length > 0) fail++; else pass++;
}

check('不变量:' + checked + '/' + FIXTURE.cases.length + ' 个决策点成立(前缀合法 / 前缀可解 / 加致命牌证明不可解 / 见证首手=正确着)',
  anomalies === 0 && checked === FIXTURE.cases.length, '异常 ' + anomalies + ' 个');
check('基线量:盲点 ' + blindSpots + '/18(advanceOf 给致命牌更高效能)——下降=改进(请人工下修基线),上升=退化',
  blindSpots === 18);

console.log('');
console.log('结果:' + pass + ' 通过,' + fail + ' 失败');
if (fail > 0) process.exit(1);
