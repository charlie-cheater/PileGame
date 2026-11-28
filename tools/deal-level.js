// ============================================================================
// tools/deal-level.js — 布局器批量生成 + 新基线观测(单臂测量)+ 导出体验关
//
// 布局器 M0(assets/scripts/planner/TypeDealer.ts):代理看见一张牌,布局器才给它定类型;
// 发牌规则 = 池内等概率,只守奇偶(每种图案最终偶数张,张数不限)。
//
// 本脚本产出:
//   构建局     布局器边发、代理边玩的那一局。默认梯是确定性的(各梯择优平分取 tileId 小者,
//              随机数只用于 wander / 兜底),所以这一局就是成品对默认玩家的结局——换代理种子不会变
//   重放一致   成品重新加载、不带布局器再玩一遍,与构建局逐手比对(管线自检,应全一致)
//   定型观测   开局批 / 每局事件数 / 批大小分布 / 最小余量 U−O / 图案张数分布 / 死局收尾补牌
//
// 口径:盘面 assets/data/layouts/test_layout.json(70 张);发牌 seed 1000+i;
//       代理 seed 2000+i(只对随机策略有意义,沿用惯例);图案池取前 n 种。
// 「换玩家」的稳健性(不同梯配置 / 人格)不在此测——那是布局器各变体的对照实验,由设计者发起。
// 与 RandomFill 基线不可直接比:那个按固定配额抽,这里每种图案张数不限。
// 本脚本 = 单臂测量。
//
// 用法:
//   node tools/deal-level.js                              两档各 150 局 + 导出体验关
//   node tools/deal-level.js 300 14                       只跑 14 图案池,300 局
//   node tools/deal-level.js 150 14,23 v3check --no-export 指定编译树、不导出
// 导出:assets/resources/levels/deal_m0_<池>_clear|fail.json(麻将元素名,编辑器 playLevel 可加载)
//       clear / fail = 默认代理通关 / 没打通——不是理想求解器的判定(fail 的盘可能其实有解,
//       导出行会标出求解器标签)。与 pick-levels 的 _win/_dead(求解器判定)不是一回事
// 报告:tools/deal-level-report.json
//
// 编译:
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Ladder.ts assets/scripts/agent/Runner.ts \
//     assets/scripts/planner/TypeDealer.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const EXPORT = !process.argv.includes('--no-export');
const GAMES = Number(args[0] || 150);
const tiers = String(args[1] || '14,23').split(',').map(Number);
const TREE = args[2] || 'v3check';

if (!(GAMES > 0) || tiers.length === 0 || tiers.some(n => !Number.isInteger(n) || n <= 0 || n > 27)) {
  console.error('用法:node tools/deal-level.js [局数=150] [图案池=14,23] [编译树=v3check] [--no-export]');
  process.exit(2);
}

const root = path.join(__dirname, '..', 'temp', TREE);
const T = {
  Board: require(path.join(root, 'core/Board')).Board,
  validateLevelData: require(path.join(root, 'core/LevelBuilder')).validateLevelData,
  runAgent: require(path.join(root, 'agent/Runner')).runAgent,
  ladderPolicy: require(path.join(root, 'agent/Ladder')).ladderPolicy,
  dealProgressively: require(path.join(root, 'planner/TypeDealer')).dealProgressively,
  buildMahjongElements: require(path.join(root, 'core/MahjongSet')).buildMahjongElements,
  solvePile: require(path.join(root, 'core/PileSolver')).solvePile,
};

const mkEls = n => Array.from({ length: n }, (_, i) =>
  ({ elementId: 'u' + (i + 1), displayName: '元素' + (i + 1), color: '#fff' }));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f1 = x => Number.isNaN(x) ? '-' : x.toFixed(1);
const f2 = x => Number.isNaN(x) ? '-' : x.toFixed(2);
const OUT_DIR = path.join(__dirname, '..', 'assets', 'resources', 'levels');
const report = { generatedAt: new Date().toISOString(), tree: TREE, games: GAMES, layout: 'test_layout', tiers: {} };

for (const n of tiers) {
  const pool = mkEls(n);
  const rules = {};
  const build = { cleared: 0, pressure: [], pairs: [], finishedDead: [] };
  const replays = { same: 0 };
  const ev = [], opening = [], hist = { 1: 0, 2: 0, 3: 0, g4: 0 }, histNoOpening = { 1: 0, 2: 0, 3: 0, g4: 0 };
  const margins = [], countMin = [], countMax = [], unused = [];
  let ms = 0;

  for (let i = 0; i < GAMES; i++) {
    const t0 = process.hrtime.bigint();
    const res = T.dealProgressively(LAYOUT, { pool, seed: 1000 + i, agent: { seed: 2000 + i } });
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    const run = res.run, st = res.dealer.stats;

    // 构建局
    if (run.outcome === 'cleared') build.cleared++;
    build.pressure.push(run.maxSlotPressure);
    build.pairs.push(run.pairsEliminated);
    if (run.outcome !== 'cleared') build.finishedDead.push(st.finished);
    for (const s of run.steps) {
      const rule = (s.operation || {}).rule ?? '?';
      rules[rule] = (rules[rule] || 0) + 1;
    }
    // 重放一致(不带布局器)
    const again = T.runAgent(new T.Board(JSON.parse(JSON.stringify(res.level))), { decision: T.ladderPolicy() });
    if (again.outcome === run.outcome && again.picks === run.picks
      && again.steps.every((s, k) => s.chosenTile === run.steps[k].chosenTile)) replays.same++;

    // 定型观测
    ev.push(st.events); opening.push(st.opening);
    st.batches.forEach((b, k) => {
      const key = b >= 4 ? 'g4' : b;
      hist[key]++;
      if (k > 0) histNoOpening[key]++;
    });
    margins.push(st.minMargin);
    const counts = new Map();
    for (const t of res.level.tiles) counts.set(t.elementId, (counts.get(t.elementId) ?? 0) + 1);
    const vals = pool.map(e => counts.get(e.elementId) ?? 0);
    countMin.push(Math.min(...vals)); countMax.push(Math.max(...vals));
    unused.push(vals.filter(v => v === 0).length);
  }

  const totalBatches = hist[1] + hist[2] + hist[3] + hist.g4;
  const totalNoOpening = histNoOpening[1] + histNoOpening[2] + histNoOpening[3] + histNoOpening.g4;
  const share = (h, tot) => `1 张 ${tot ? (100 * h[1] / tot).toFixed(0) : 0}% / 2 张 ${tot ? (100 * h[2] / tot).toFixed(0) : 0}%`
    + ` / 3 张 ${tot ? (100 * h[3] / tot).toFixed(0) : 0}% / ≥4 张 ${tot ? (100 * h.g4 / tot).toFixed(0) : 0}%`;
  const ruleLine = Object.entries(rules).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ');

  console.log(`【${n} 图案池 × ${GAMES} 局】`);
  console.log(`  构建局       通关 ${build.cleared}/${GAMES}(${(100 * build.cleared / GAMES).toFixed(1)}%)`
    + ` | 平均槽压峰值 ${f2(mean(build.pressure))} | 平均消除对 ${f2(mean(build.pairs))}`);
  console.log(`  重放一致     ${replays.same}/${GAMES}(成品不带布局器重放,逐手相同)`);
  console.log(`  各梯出手     ${ruleLine}`);
  console.log(`  定型         开局批 ${f1(mean(opening))} 张 | 每局 ${f1(mean(ev))} 次事件`);
  console.log(`  批大小       全部(${totalBatches} 批):${share(hist, totalBatches)}`);
  console.log(`               除开局批(${totalNoOpening} 批):${share(histNoOpening, totalNoOpening)}`);
  console.log(`  最小余量 U−O 每局最小值:中位数 ${median(margins)} / 最小 ${Math.min(...margins)} / 降到 0 的局 ${margins.filter(m => m === 0).length}`);
  console.log(`  图案张数     每盘最少 ${f1(mean(countMin))} / 最多 ${f1(mean(countMax))} 张;没出现的图案 ${f1(mean(unused))} 种`);
  console.log(`  死局收尾     平均补 ${f2(mean(build.finishedDead))} 张(${build.finishedDead.length} 局)| 每局构建耗时 ${(ms / GAMES).toFixed(0)} ms`);

  report.tiers[n] = {
    build: { cleared: build.cleared, games: GAMES, pressure: mean(build.pressure), pairs: mean(build.pairs) },
    replayConsistent: replays.same,
    rules,
    events: mean(ev), opening: mean(opening),
    batches: { all: hist, excludingOpening: histNoOpening },
    minMargin: { median: median(margins), min: Math.min(...margins), zeroGames: margins.filter(m => m === 0).length },
    patternCount: { min: mean(countMin), max: mean(countMax), unused: mean(unused) },
    deadFinish: { games: build.finishedDead.length, mean: mean(build.finishedDead) },
    msPerGame: ms / GAMES,
  };
}

// ─────────────────────────── 导出体验关 ───────────────────────────
if (EXPORT) {
  for (const n of tiers) {
    const pool = T.buildMahjongElements().slice(0, n);
    const found = { clear: null, fail: null };
    for (let i = 0; i < 3 * GAMES && !(found.clear && found.fail); i++) {
      const res = T.dealProgressively(LAYOUT, { pool, seed: 1000 + i, agent: { seed: 2000 + i } });
      const kind = res.run.outcome === 'cleared' ? 'clear' : 'fail';
      if (!found[kind]) found[kind] = { i, level: res.level, run: res.run };
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const kind of ['clear', 'fail']) {
      const f = found[kind];
      const kindName = kind === 'clear' ? '代理通关' : '代理没打通';
      if (!f) { console.log(`  ✗ ${n} 图案池:扫了 ${3 * GAMES} 个种子没找到「${kindName}」的盘,未导出`); continue; }
      const name = `deal_m0_${n}_${kind}`;
      // 经游戏管线复核:校验通过 + 不带布局器重放的结局与标签相符;另附理想求解器标签
      const v = T.validateLevelData(f.level);
      const replay = T.runAgent(new T.Board(JSON.parse(JSON.stringify(f.level))), { decision: T.ladderPolicy() });
      const ok = v.length === 0 && (kind === 'clear' ? replay.outcome === 'cleared' : replay.outcome !== 'cleared');
      if (!ok) { console.log(`  ✗ ${name} 复核未通过:${v.join('; ')} | 重放 ${replay.outcome}`); continue; }
      const s = T.solvePile(new T.Board(JSON.parse(JSON.stringify(f.level))).allTiles().filter(t => t.status === 'pile'), { maxNodes: 2000000 });
      const solver = s.status === 'solved' ? `求解器可通关(${s.witness.length} 手见证)`
        : (s.nodes < 2000000 ? `求解器穷举证明不可解(${s.nodes} 节点)` : '求解器预算内未判定');
      fs.writeFileSync(path.join(OUT_DIR, name + '.json'), JSON.stringify(f.level));
      console.log(`  ✓ 导出 ${name}.json(seed ${1000 + f.i};${kindName},${replay.picks} 手,消除 ${replay.pairsEliminated} 对 | ${solver})`);
    }
  }
}

fs.writeFileSync(path.join(__dirname, 'deal-level-report.json'), JSON.stringify(report, null, 1));
console.log('报告:tools/deal-level-report.json');
