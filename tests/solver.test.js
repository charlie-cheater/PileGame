// ============================================================================
// solver.test.js — PileSolver(理想求解器/单侧验证器)回归测试(node 直跑,不依赖 cc)
//
// 编译(同其它套件):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/solver.test.js
//
// 覆盖口径(2026-11-26,性质为主):
//   · 见证有效性:solved 的 witness 逐张重放必清盘
//   · 可解下传:代理清盘 ⇒ 盘面可解(solver 必 SOLVED)——单侧验证器的 soundness
//   · 中局接管:对局中途的 R 出发求解仍可解、见证续放清盘(供归因层二分回溯)
//   · 预算:同参重跑节点数逐位一致(确定性);小预算诚实返回 UNKNOWN
// ============================================================================

const { Board } = require('../temp/v3check/core/Board');
const { buildOcclusionIndex } = require('../temp/v3check/core/Occlusion');
const { solvePile } = require('../temp/v3check/core/PileSolver');
const { buildFilledLevel } = require('../temp/v3check/core/RandomFill');
const { runAgent } = require('../temp/v3check/agent/Runner');
const { ladderPolicy } = require('../temp/v3check/agent/Ladder');
const LAYOUT = require('../assets/data/layouts/test_layout.json');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}
const level = (w, h, spec) => {
  const tiles = spec.map(([elementId, gx, gy, layer], i) => ({ elementId, variant: 'FULL', gx, gy, layer, tileId: i }));
  const ids = [...new Set(tiles.map(t => t.elementId))];
  return { board: { w, h }, elements: ids.map(e => ({ elementId: e, displayName: e, color: '#fff' })), tiles };
};
/** 求解盘面:遮挡索引必须建自全 pile 盘(buildOcclusionIndex 有状态校验),
 *  故从等级数据重建全新 Board 取牌与索引;中局接管经 opts.initialRemoved 传入 */
const solveBoard = (levelData, opts) => {
  const fresh = new Board(levelData);
  return solvePile(fresh.allTiles(), { ...opts, index: buildOcclusionIndex(fresh.allTiles()) });
};
/** 见证重放:逐张拿(闭对即消除),返回终点盘 */
function replay(levelData, picks) {
  const b = new Board(levelData);
  for (const t of picks) {
    const p = b.pick(t);
    if (!p.ok) return { ok: false, board: b };
    if (p.paired) { b.eliminate(p.paired[0], p.paired[1]); b.compactSlots(); }
  }
  return { ok: true, board: b };
}

console.log('— PileSolver:单侧验证器(评估层上界量尺,2026-11-26)—');
{
  // S1 手盘:双对全顶层(X X A A)→ 可解,见证重放清盘
  const lv = level(48, 14, [['X', 8, 2, 0], ['X', 16, 2, 0], ['A', 24, 2, 0], ['A', 32, 2, 0]]);
  const r = solveBoard(lv);
  const rp = replay(lv, r.witness);
  check('S1 双对平铺:solved,见证 4 拿,重放清盘',
    r.status === 'solved' && r.witness.length === 4 && rp.ok && rp.board.isCleared(),
    `status=${r.status} witness=${JSON.stringify(r.witness)} nodes=${r.nodes}`);
}
{
  // S2 奇数孤儿盘:全移除也留 3 开 → 小空间内穷尽 = unknown(不证伪口径下的诚实返回)
  const lv = level(64, 14, [['X', 8, 2, 0], ['X', 16, 2, 0], ['A', 24, 2, 0], ['B', 32, 2, 0], ['C', 40, 2, 0]]);
  const r = solveBoard(lv);
  check('S2 含孤儿(不可清)结构:穷尽小空间后 unknown,见证为空',
    r.status === 'unknown' && r.witness.length === 0,
    `status=${r.status} witness=${JSON.stringify(r.witness)}`);
}
{
  // P 性质:随机盘上「代理清盘 ⇒ SOLVED + 见证重放清盘」(soundness 主网)
  const els14 = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const bad = [];
  let clearedGames = 0;
  for (let g = 0; g < 10; g++) {
    const lvData = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els14, seed: 1000 + g });
    const r = runAgent(new Board(lvData), { seed: 2000 + g, decision: ladderPolicy() });
    if (r.outcome !== 'cleared') continue;
    clearedGames++;
    const s = solveBoard(lvData);
    if (s.status !== 'solved') { bad.push(`盘${g}:代理清盘但 solver=${s.status} nodes=${s.nodes}`); continue; }
    const rp = replay(lvData, s.witness);
    if (!rp.ok || !rp.board.isCleared()) bad.push(`盘${g}:见证重放未清盘(ok=${rp.ok} 槽=${rp.board.slotCount()} 堆=${rp.board.pileCount()})`);
  }
  check(`性质:10 盘中代理清盘 ${clearedGames} 局全部 SOLVED 且见证重放清盘`,
    clearedGames > 0 && bad.length === 0, bad.slice(0, 2).join('\n       '));
}
{
  // P 性质:中局接管——代理轨迹一半的 R 出发求解必可解(代理从那里走到了清盘),
  //   见证从半局盘面续放清盘(归因层二分回溯的地基)
  const els14 = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const bad = [];
  let tried = 0;
  for (let g = 0; g < 10 && tried < 3; g++) {
    const lvData = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els14, seed: 1000 + g });
    const r = runAgent(new Board(lvData), { seed: 2000 + g, decision: ladderPolicy() });
    if (r.outcome !== 'cleared' || r.steps.length < 4) continue;
    tried++;
    const half = Math.floor(r.steps.length / 2);
    const bMid = new Board(lvData);
    for (let i = 0; i < half; i++) {
      const p = bMid.pick(r.steps[i].chosenTile);
      if (p.paired) { bMid.eliminate(p.paired[0], p.paired[1]); bMid.compactSlots(); }
    }
    const r0 = new Set(bMid.allTiles().filter(t => t.status !== 'pile').map(t => t.tileId));
    const s = solveBoard(lvData, { initialRemoved: r0 });
    if (s.status !== 'solved') { bad.push(`盘${g}@${half}:半局可解线出发 solver=${s.status} nodes=${s.nodes}`); continue; }
    // 半局复现 + 见证续放
    const b2 = new Board(lvData);
    const pre = r.steps.slice(0, half).map(x => x.chosenTile);
    let ok = true;
    for (const t of pre.concat(s.witness)) {
      const p = b2.pick(t);
      if (!p.ok) { ok = false; bad.push(`盘${g}@${half}:续放手 ${t} 被拒(${p.reason})`); break; }
      if (p.paired) { b2.eliminate(p.paired[0], p.paired[1]); b2.compactSlots(); }
    }
    if (ok && !b2.isCleared()) bad.push(`盘${g}@${half}:续放走完未清盘(槽 ${b2.slotCount()} 堆 ${b2.pileCount()})`);
  }
  check(`性质:${tried} 局半局接管全部 SOLVED 且「前半轨迹 + 见证」续放清盘`,
    tried > 0 && bad.length === 0, bad.slice(0, 2).join('\n       '));
}
{
  // S3 预算确定性 + 小预算诚实 UNKNOWN
  const els23 = Array.from({ length: 23 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const lvData = buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els23, seed: 1000 });
  const a = solveBoard(lvData, { maxNodes: 50000 });
  const b2 = solveBoard(lvData, { maxNodes: 50000 });
  check('S3a 预算确定性:同盘同预算两次,状态与节点数逐位一致',
    a.status === b2.status && a.nodes === b2.nodes,
    `${a.status}/${a.nodes} vs ${b2.status}/${b2.nodes}`);
  const tiny = solveBoard(lvData, { maxNodes: 10 });
  check('S3b 小预算诚实 UNKNOWN:10 节点内放弃,见证为空',
    tiny.status === 'unknown' && tiny.witness.length === 0 && tiny.nodes <= 11,
    `status=${tiny.status} nodes=${tiny.nodes}`);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
if (fail > 0) process.exit(1);
