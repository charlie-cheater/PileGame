// tools/pick-levels.js — 用理想求解器筛「可通关 / 不可通关」关卡并导出交互测试盘
// (2026-11-27 设计者指示:筛选 14/23 元素的两种盘各一盘,供编辑器内实际体验;
//  用法: node tools/pick-levels.js [每档扫描种子数=80] [节点预算=2000000])
//
// 判定口径(单侧验证器):
//   可通关   = PileSolver solved(附见证);优先选默认代理也能通关的盘(有参照胜线)
//   不可通关 = unknown 且 nodes < 预算(可达状态空间穷尽 = 穷举证明不可解);
//              优先选代理存活较久的盘(玩家能实际打一阵才撞墙,体验更完整)
// 导出:assets/resources/levels/*.json(LevelData,麻将元素名,编辑器直接可玩)
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', 'temp', 'v3check');
const { Board } = require(path.join(root, 'core', 'Board'));
const { buildOcclusionIndex } = require(path.join(root, 'core', 'Occlusion'));
const { solvePile } = require(path.join(root, 'core', 'PileSolver'));
const { buildFilledLevel } = require(path.join(root, 'core', 'RandomFill'));
const { buildMahjongElements } = require(path.join(root, 'core', 'MahjongSet'));
const { runAgent } = require(path.join(root, 'agent', 'Runner'));
const { ladderPolicy } = require(path.join(root, 'agent', 'Ladder'));
const LAYOUT = require(path.join(__dirname, '..', 'assets', 'data', 'layouts', 'test_layout.json'));

const SCAN = Number(process.argv[2] || 80);
const MAX_NODES = Number(process.argv[3] || 2000000);
const MIN_DEAD_PICKS = Number(process.argv[4] || 20);
const OUT_DIR = path.join(__dirname, '..', 'assets', 'resources', 'levels');
const MAHJONG = buildMahjongElements();

const rngOf = seed => { let s = seed % 2147483648; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; };

function scanTier(tier) {
  const els14 = Array.from({ length: tier }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const found = { win: null, dead: null };
  for (let g = 0; g < SCAN && (!found.win || !found.dead); g++) {
    const seed = 1000 + g;
    const lvU = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els14, seed });
    // 代理参照(判定结构同构性:u 名版与麻将名版逐槽同构)
    const r = runAgent(new Board(lvU), { seed: 2000 + g, decision: ladderPolicy() });
    const lvM = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: MAHJONG.slice(0, tier), seed });
    const index = buildOcclusionIndex(new Board(lvM).allTiles());
    const res = solvePile(new Board(lvM).allTiles(), { maxNodes: MAX_NODES, index });
    const provenDead = res.status === 'unknown' && res.nodes < MAX_NODES;
    const rec = {
      tier, seed,
      solver: res.status, nodes: res.nodes,
      agent: r.outcome, picks: r.picks,
      witness: res.witness,
      mahjongEls: MAHJONG.slice(0, tier),
      levelMahjong: lvM,
    };
    if (!found.win && res.status === 'solved' && r.outcome === 'cleared') found.win = rec;
    if (!found.dead && provenDead && r.picks >= MIN_DEAD_PICKS) found.dead = rec;
    console.log('  ' + tier + 'T seed ' + seed + ': solver=' + res.status + ' nodes=' + res.nodes
      + ' agent=' + r.outcome + '(' + r.picks + ' 手)' + (provenDead ? ' [证明不可解]' : '') + (res.status === 'solved' ? ' [可解]' : ''));
  }
  return found;
}

function writeLevel(rec, name) {
  const lv = rec.levelMahjong;
  const out = { board: lv.board, elements: lv.elements, tiles: lv.tiles };
  const f = path.join(OUT_DIR, name + '.json');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out));
  console.log('  导出 ' + f + '(' + lv.tiles.length + ' 张)');
}

const results = {};
for (const tier of [14, 23]) {
  console.log('【' + tier + ' 元素】扫描 ' + SCAN + ' 个种子…');
  const found = scanTier(tier);
  results[tier] = found;
  if (found.win) {
    found.win.name = 'level_' + tier + '_win';
    writeLevel(found.win, found.win.name);
    console.log('  ✓ 可通关: seed ' + found.win.seed + ' | 代理 ' + found.win.picks + ' 手通关 | 见证 ' + found.win.witness.length + ' 手');
  } else console.log('  ✗ 可通关: 扫描范围内未找到');
  if (found.dead) {
    found.dead.name = 'level_' + tier + '_dead';
    writeLevel(found.dead, found.dead.name);
    console.log('  ✓ 不可通关: seed ' + found.dead.seed + ' | 代理 ' + found.dead.picks + ' 手后撞墙(穷举证明)');
  } else console.log('  ✗ 不可通关: 扫描范围内未找到(放宽 picks≥20 或加大扫描)');
}
fs.writeFileSync(path.join(__dirname, 'pick-levels-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  scan: SCAN, maxNodes: MAX_NODES,
  picks: Object.entries(results).map(([tier, f]) => ({
    tier, win: f.win && { seed: f.win.seed, witness: f.witness },
    dead: f.dead && { seed: f.dead.seed },
  })),
}, null, 1));
console.log('报告: temp/pick-levels-report.json');
