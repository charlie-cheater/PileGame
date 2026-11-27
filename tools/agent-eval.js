// ============================================================================
// tools/agent-eval.js — 代理效果评估(分层通关率基准;2026-11-26 设计者立项)
//
// 定位:回答「当前算法距局部最优多远」的量尺。评估层允许客观、代理层保持主观
// (设计评审 2026-11-26);与 agent-observe.js 的变体对照协议互补——
//   observe 回答「改动有没有用」,eval 回答「当前离上限多远、输在哪层」。
//
// 本阶段(第 1+2 层:可解标签 + 难度分层基准):
//   · 求解器上界 = 每盘单侧验证(PileSolver,节点预算 200 万;UNKNOWN = 不判定);
//     上界距离 = SOLVED 未被代理通关的盘数 = 「局部最优差距」的下界
//   · 基准口径 = **折叠随机**(de Bondt Random solving 口径,§技术阶梯 7):闭对是
//     P2 强制着,有闭必闭;开新对时在可点牌里均匀随机。实测纯均匀随机在 14/23
//     档 150 盘全部 0%(2026-11-26),无分辨率,故不采用
//   · 代理基准 = 默认梯同种子各一局(与 observe 同协议:代理 seed 2000+i)
//   · 分层交叉:代理通关率按基准难度分桶列出——「送分层丢了多少盘」
//     是可改进空间的下界;上界距离要等求解器标签(第 1 层)接入
//
// 难度分桶(按基准通关率):0% / 1-19% / 20-59% / 60-99% / 100%
//
// 确定性:逐局 LCG,种子 = 90000 + 盘序×131 + 局序;同参数重跑逐字节一致
//
// 用法:
//   node tools/agent-eval.js [档位=14,23] [盘数=150] [折叠随机局数=30] [变体树=v3check] [detail]
//   detail = 逐盘一行 CSV(tier,seed,wanderClears,wanderN,agentOutcome)
// ============================================================================

const path = require('path');
const LAYOUT = require('../assets/data/layouts/test_layout.json');

const args = process.argv.slice(2);
const tiers = String(args[0] || '14,23').split(',').map(Number);
const BOARDS = Number(args[1] || 150);
const PLAYOUTS = Number(args[2] || 30);
const TREE = args[3] || 'v3check';
const DETAIL = args.includes('detail');
const root = path.join(__dirname, '..', 'temp', TREE);

const { Board } = require(path.join(root, 'core/Board'));
const { buildFilledLevel } = require(path.join(root, 'core/RandomFill'));
const { runAgent } = require(path.join(root, 'agent/Runner'));
const { ladderPolicy } = require(path.join(root, 'agent/Ladder'));
const { buildOcclusionIndex } = require(path.join(root, 'core/Occlusion'));
const { solvePile } = require(path.join(root, 'core/PileSolver'));

const MAX_NODES = 2000000;                          // 求解器节点预算(确定性)

if (!(BOARDS > 0) || !(PLAYOUTS > 0) || tiers.length === 0 || tiers.some(n => !Number.isInteger(n) || n <= 0)) {
  console.error('用法:node tools/agent-eval.js [档位=14,23] [盘数=150] [折叠随机局数=30] [变体树=v3check] [detail]');
  process.exit(2);
}

// LCG(与各套件同族):确定性,每局独立种子
const rngOf = seed => {
  let s = seed % 2147483648;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

/** 折叠随机单局:有闭必闭(P2 强制着),开新对均匀随机;返回是否清盘 */
function foldRandomOnce(level, rng) {
  const b = new Board(level);
  let guard = level.tiles.length + 2;
  while (guard-- > 0) {
    if (b.isCleared()) return true;
    const clickable = b.clickableTiles();
    if (clickable.length === 0) return false;           // pile 空(滞留)或被锁死
    const openEls = new Set(b.slotTiles().map(t => t.elementId));
    const closing = clickable.filter(t => openEls.has(t.elementId));
    const pool = closing.length > 0 ? closing : clickable;
    const t = pool[Math.floor(rng() * pool.length)].tileId;
    const p = b.pick(t);
    if (!p.ok) return false;
    if (p.paired) { b.eliminate(p.paired[0], p.paired[1]); b.compactSlots(); }
    if (b.isSlotFull() && !b.findSlotPair()) return false;
  }
  return false;
}

const BUCKETS = [
  { name: '0%', lo: 0, hi: 0 },
  { name: '1-19%', lo: 1, hi: 19 },
  { name: '20-59%', lo: 20, hi: 59 },
  { name: '60-99%', lo: 60, hi: 99 },
  { name: '100%', lo: 100, hi: 100 },
];
const bucketOf = rate => BUCKETS.find(k => rate >= k.lo && rate <= k.hi);

for (const tier of tiers) {
  const els = Array.from({ length: tier }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const rows = [];
  const t0 = process.hrtime.bigint();
  for (let g = 0; g < BOARDS; g++) {
    const level = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed: 1000 + g });
    let clears = 0;
    for (let pIdx = 0; pIdx < PLAYOUTS; pIdx++) {
      const rng = rngOf(90000 + g * 131 + pIdx * 7);
      if (foldRandomOnce(level, rng)) clears++;
    }
    const r = runAgent(new Board(level), { seed: 2000 + g, decision: ladderPolicy() });
    // 第 1 层:可解标签(单侧验证器;SOLVED 附见证,UNKNOWN = 预算内不判定)
    const fresh = new Board(level);
    const solver = solvePile(fresh.allTiles(), { maxNodes: MAX_NODES, index: buildOcclusionIndex(fresh.allTiles()) });
    rows.push({ tier, seed: 1000 + g, clears, n: PLAYOUTS, agent: r.outcome, agentPicks: r.picks,
      solver: solver.status, solverNodes: solver.nodes,
      steps: r.steps.map(s => ({ t: s.chosenTile, rule: s.operation ? s.operation.rule : '?' })) });
  }
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;

  // 汇总
  const totalClears = rows.reduce((s, r) => s + r.clears, 0);
  const agentCleared = rows.filter(r => r.agent === 'cleared').length;
  const solved = rows.filter(r => r.solver === 'solved').length;
  const unknown = rows.length - solved;
  const solvableButLost = rows.filter(r => r.solver === 'solved' && r.agent !== 'cleared').length;
  console.log(`【${tier} 元素】${BOARDS} 盘 × 折叠随机 ${PLAYOUTS} 局/盘 · 代理各 1 局(${TREE}) · 求解器 ${MAX_NODES / 10000} 万节点/盘 · ${dt.toFixed(1)}s`);
  console.log(`  基准均摊通关率 ${(totalClears / (rows.length * PLAYOUTS) * 100).toFixed(1)}% | 代理通关率 ${(agentCleared / rows.length * 100).toFixed(1)}%`);
  console.log(`  可解(SOLVED) ${solved}/${rows.length}(${(solved / rows.length * 100).toFixed(1)}%) | UNKNOWN ${unknown} | 上界距离(可解未通) ${solvableButLost} 盘 = 局部最优差距下界`);
  for (const k of BUCKETS) {
    const inBucket = rows.filter(r => {
      const rate = r.clears / r.n * 100;
      return rate >= k.lo && rate <= k.hi;
    });
    if (inBucket.length === 0) continue;
    const agentWin = inBucket.filter(r => r.agent === 'cleared').length;
    console.log(`  桶 ${k.name.padStart(6)} : 盘 ${String(inBucket.length).padStart(3)} | 代理通关 ${String(agentWin).padStart(3)}(${(agentWin / inBucket.length * 100).toFixed(0)}%)`);
  }
  // 第 3 层:死亡回放归因(对 SOLVED 未通的盘;不可解性沿轨迹单调 → 二分定位失误手)
  const attributions = [];
  let attributionSkipped = 0;
  for (const row of rows) {
    if (row.solver !== 'solved' || row.agent === 'cleared') continue;
    const steps = row.steps;
    if (!steps || steps.length === 0) { attributionSkipped++; continue; }
    const lv = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed: row.seed });
    const allTiles = new Board(lv).allTiles();
    const index = buildOcclusionIndex(allTiles);
    const prefixes = [new Set()];
    for (let i = 0; i < steps.length; i++) {
      const s = new Set(prefixes[i]);
      s.add(steps[i].t);
      prefixes.push(s);
    }
    const solvableAt = i => solvePile(allTiles, { initialRemoved: prefixes[i], index, maxNodes: MAX_NODES }).status === 'solved';
    let lo = 0, hi = steps.length;                    // P_lo 可解(盘面 SOLVED),P_hi = 败局(不可解)
    if (solvableAt(hi)) { attributionSkipped++; continue; }   // 预算内终局仍判可解:放弃归因
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (solvableAt(mid)) lo = mid; else hi = mid;
    }
    const wit = solvePile(allTiles, { initialRemoved: prefixes[lo], index, maxNodes: MAX_NODES });
    attributions.push({ tier: row.tier, seed: row.seed, step: hi, total: steps.length,
      rule: steps[hi - 1].rule, agentPick: steps[hi - 1].t, correct: wit.witness[0] });
  }
  const byRung = {};
  for (const a of attributions) byRung[a.rule] = (byRung[a.rule] || 0) + 1;
  const rungLine = Object.entries(byRung).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)';
  const stepPct = attributions.map(a => Math.round(a.step / a.total * 100)).sort((x, y) => x - y);
  const medianPct = stepPct.length ? stepPct[Math.floor(stepPct.length / 2)] : -1;
  console.log(`  归因(可解未通 ${solvableButLost} 盘):定位 ${attributions.length},放弃 ${attributionSkipped}(预算内终局仍可解)`);
  console.log(`  失误手所属梯: ${rungLine} | 失误步位置中位: ${medianPct}% 处`);
  if (DETAIL) {
    console.log('  归因明细: tier,seed,失误步/总步,失误梯,代理拿,正确着');
    for (const a of attributions) console.log(`  ${a.tier},${a.seed},${a.step}/${a.total},${a.rule},${a.agentPick},${a.correct}`);
  }
}
