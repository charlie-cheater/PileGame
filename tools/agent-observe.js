// ============================================================================
// tools/agent-observe.js — 代理决策改动的批量观测(同盘、同种子、多棵编译树、逐局对照)
//
// 「改动观测结构」的入库版本(2026-11-25 设计者指示记录)。后续迭代决策时照此复测:
//
//   语料     assets/data/layouts/test_layout.json(70 张 = 35 对),RandomFill 随机填充
//   档位     默认 14 / 23 个元素(配额自动均分:每元素 5 / 3 张)。
//            2026-11-25 指示:35 元素档撤出——对照太重;
//            2026-11-26 指示:7 元素档(恒 100%)与 35 元素档(恒 0%)撤出——数据没有价值。
//            需要时用档位参数显式加回(如 7,14,23,35)
//   局数     默认每档 150 局(2026-11-25 设计者指示;此前惯用 300)
//   种子     填充 seed 1000+i,代理 seed 2000+i,i = 0..N-1——各变体跑的是同一批盘
//   变体     temp/ 下的编译产物目录 = 决策代码的一个版本;改动前的版本把旧提交的源码
//            编译到另一个目录即可同盘对照
//   指标     通关率 / 平均槽压峰值 / 平均消除对 / 耗时 / 各梯出手次数
//   dig 观测 每次出手时报告里的 hold / dig 配对数、其中可执行数、涉及元素数(reason.scan
//            随轨迹落盘,本脚本做汇总);所选匹配的平均消耗
//   对照     以第一个变体为基线,逐局对照输赢与选牌序列
//
//   发起纪律  求解率对照测试由设计者发起,AI 不得自行跑批量对照(2026-11-25 指示)
//
// 耗时只在同一次运行内可比(各变体在同一进程里先后跑);不同次运行的绝对耗时不可比。
//
// 用法:
//   node tools/agent-observe.js [变体列表] [每档局数=150] [档位列表=14,23]
//   变体 = temp/ 下的编译树名,逗号分隔;缺省 v3check(= 当前源码)
//   例:
//     node tools/agent-observe.js                                   当前默认梯,两档各 150 局
//     node tools/agent-observe.js v3check_base,v3check 150          改动前 / 改动后
//     node tools/agent-observe.js v3check 150 7,14,23,35            显式跑全部四档
//
// 编译(把 <outDir> 换成要用的编译树名):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Ladder.ts assets/scripts/agent/Runner.ts \
//     --rootDir assets/scripts --outDir temp/<outDir> \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const path = require('path');

const DEFAULT_TIERS = '14,23';
const DEFAULT_TREE = 'v3check';
// 启动梯 startup 已于 2026-11-25 移除;保留在顺序表里,对照旧编译树时仍能显示它的出手数
const RULE_ORDER = ['startup', 'slot-close', 'pair-complete', 'dig', 'explore'];

// ─────────────────────────── 参数 ───────────────────────────

const args = process.argv.slice(2);
const variantSpecs = (args[0] || DEFAULT_TREE).split(',').map(s => s.trim()).filter(Boolean);
const GAMES = Number(args[1] || 150);
const tiers = String(args[2] || DEFAULT_TIERS).split(',').map(Number);

if (!(GAMES > 0) || tiers.length === 0 || tiers.some(n => !Number.isInteger(n) || n <= 0)) {
  console.error('用法:node tools/agent-observe.js [变体列表] [每档局数=150] [档位列表=14,23]');
  process.exit(2);
}

const mkEls = n => Array.from({ length: n }, (_, i) =>
  ({ elementId: 'u' + (i + 1), displayName: '元素' + (i + 1), color: '#fff' }));

/** 载入一棵编译树 */
function loadTree(tree) {
  const root = path.join(__dirname, '..', 'temp', tree);
  return {
    Board: require(path.join(root, 'core/Board')).Board,
    RandomFill: require(path.join(root, 'core/RandomFill')),
    Runner: require(path.join(root, 'agent/Runner')),
    Ladder: require(path.join(root, 'agent/Ladder')),
  };
}

const variants = variantSpecs.map(tree => ({ name: tree, T: loadTree(tree), decision: loadTree(tree).Ladder.ladderPolicy() }));

// ─────────────────────────── 运行 ───────────────────────────

/** 各档的关卡只生成一次(取第一个变体的编译树),所有变体跑同一批盘 */
const levels = {};
for (const n of tiers) {
  const els = mkEls(n);
  levels[n] = [];
  for (let i = 0; i < GAMES; i++) {
    levels[n].push(JSON.stringify(
      variants[0].T.RandomFill.buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed: 1000 + i })));
  }
}

/** 跑一个变体:各档 × GAMES 局 */
function runVariant(v) {
  const out = {};
  let totalMs = 0;
  for (const n of tiers) {
    const rules = {};
    const games = [];
    // dig 梯观测:出手数 / 报告里的 hold / dig 配对总数 / 可执行配对总数 / 元素数总数 / 所选匹配的消耗合计
    const dig = { acts: 0, pairs: 0, executable: 0, elements: 0, cost: 0 };
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < GAMES; i++) {
      const r = v.T.Runner.runAgent(new v.T.Board(JSON.parse(levels[n][i])), { seed: 2000 + i, decision: v.decision });
      for (const s of r.steps) {
        const op = s.operation || {};
        const rule = op.rule ?? '?';
        rules[rule] = (rules[rule] || 0) + 1;
        if (rule !== 'dig') continue;
        dig.acts++;
        if (op.match) dig.cost += op.match.matchCost;
        if (!op.scan) continue;
        dig.pairs += op.scan.pairs;
        dig.executable += op.scan.executable;
        dig.elements += op.scan.elements;
      }
      games.push({
        win: r.outcome === 'cleared' ? 1 : 0,
        pressure: r.maxSlotPressure,
        pairs: r.pairsEliminated,
        seq: r.steps.map(s => s.chosenTile).join(','),
      });
    }
    out[n] = { games, rules, dig, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    totalMs += out[n].ms;
  }
  out.totalMs = totalMs;
  return out;
}

const results = variants.map(runVariant);

// ─────────────────────────── 输出 ───────────────────────────

const mean = (sum, n) => (n > 0 ? (sum / n).toFixed(2) : '—');
const pad = (s, w) => String(s).padEnd(w);
const nameW = Math.max(26, ...variants.map(v => v.name.length)) + 2;
const rulesText = rules => RULE_ORDER.filter(k => rules[k]).map(k => `${k} ${rules[k]}`).join(' / ');

console.log(`代理决策观测 · 每档 ${GAMES} 局 · 填充 seed 1000+i · 代理 seed 2000+i · test_layout · 档位 ${tiers.join('/')}`);
console.log(`变体:${variants.map((v, i) => `${i === 0 ? '【基线】' : ''}${v.name} = temp/${v.name}`).join('  |  ')}`);

for (const n of tiers) {
  const base = results[0][n];
  console.log(`\n【${n} 元素】通关率 / 平均槽压峰值 / 平均消除对 / 耗时 / 各梯出手`);
  variants.forEach((v, k) => {
    const o = results[k][n];
    const wins = o.games.reduce((s, g) => s + g.win, 0);
    console.log(`  ${pad(v.name, nameW)}${(wins / GAMES * 100).toFixed(1).padStart(5)}%`
      + `   ${mean(o.games.reduce((s, g) => s + g.pressure, 0), GAMES).padStart(5)}`
      + `   ${mean(o.games.reduce((s, g) => s + g.pairs, 0), GAMES).padStart(5)}`
      + `   ${(o.ms / 1000).toFixed(1).padStart(6)} s   ${rulesText(o.rules)}`);
    if (k > 0) {
      let winLose = 0, loseWin = 0, seqSame = 0;
      for (let i = 0; i < GAMES; i++) {
        const a = base.games[i].win, b = o.games[i].win;
        if (a && !b) winLose++;
        if (!a && b) loseWin++;
        if (base.games[i].seq === o.games[i].seq) seqSame++;
      }
      console.log(`  ${pad('', nameW)}对基线逐局:赢→输 ${winLose} · 输→赢 ${loseWin} · 选牌一致 ${seqSame}/${GAMES}`
        + ` · 耗时 ×${(o.ms / base.ms).toFixed(2)}`);
    }
  });
  variants.forEach((v, k) => {
    const d = results[k][n].dig;
    let line = `  ${pad(v.name, nameW)}dig 出手 ${d.acts} 次`;
    if (d.acts > 0) line += ` · 所选匹配平均消耗 ${mean(d.cost, d.acts)} 格`;
    if (d.pairs > 0 || d.acts > 0) {
      line += ` · 报告 hold/dig ${d.pairs} 对(可执行 ${d.executable}),出手均摊 ${mean(d.pairs, d.acts)} 对`
        + ` / ${mean(d.elements, d.acts)} 个元素`;
    }
    console.log(line);
  });
}
console.log(`\n合计耗时:${variants.map((v, k) => `${v.name} ${(results[k].totalMs / 1000).toFixed(1)} s`).join('  |  ')}`);
