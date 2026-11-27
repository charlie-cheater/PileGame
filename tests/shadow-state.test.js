// ============================================================================
// shadow-state.test.js — 影子状态(ShadowState)回归测试(node 直跑,不依赖 cc)
//
// 编译(同其它套件):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/shadow-state.test.js
//
// 覆盖口径(2026-11-26 立项,性质为主、示例盘最少):
//   · 等价性(主网):随机盘上影子与 Board 逐节点对账——可点集、闭对判定、
//     开对数=槽内张数、终局分类一致
//   · 最小示例盘:开对/闭对/清盘、遮挡解锁 + P1 单调、容量与死局、中盘接管
//   · 回退免费:pick/undo 任意序列后状态还原
// ============================================================================

const { Board, SLOT_COUNT } = require('../temp/v3check/core/Board');
const { buildOcclusionTopology } = require('../temp/v3check/core/OcclusionTopology');
const { createShadowState } = require('../temp/v3check/core/ShadowState');
const { buildFilledLevel } = require('../temp/v3check/core/RandomFill');
const { perceive } = require('../temp/v3check/agent/Perception');
const { analyze } = require('../temp/v3check/agent/Analysis');
const { decideByLadder, defaultLadder } = require('../temp/v3check/agent/Ladder');
const LAYOUT = require('../assets/data/layouts/test_layout.json');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 手写盘(同 agent-decision 套件的 level 助手;tileId = spec 下标)
const level = (w, h, spec) => {
  const tiles = spec.map(([elementId, gx, gy, layer], i) => ({ elementId, variant: 'FULL', gx, gy, layer, tileId: i }));
  const ids = [...new Set(tiles.map(t => t.elementId))];
  return { board: { w, h }, elements: ids.map(e => ({ elementId: e, displayName: e, color: '#fff' })), tiles };
};
const shadowOf = (b, removed) => {
  const all = b.allTiles();
  return createShadowState(
    buildOcclusionTopology(all),
    all.map(t => ({ tileId: t.tileId, elementId: t.elementId })),
    removed,
  );
};

console.log('— 影子状态:与 Board 等价的轻量局面投影(P3 状态归约,2026-11-26 立项)—');
{
  // E1 开对/闭对/清盘/回退:顶层 X 对 + 两个孤儿
  //   牌:X(0) X(1) A(2) B(3) C(4)——全顶层平铺互不遮挡
  const b = new Board(level(64, 14, [['X', 8, 2, 0], ['X', 16, 2, 0], ['A', 24, 2, 0], ['B', 32, 2, 0], ['C', 40, 2, 0]]));
  const sh = shadowOf(b);
  check('前置:5 张全可点(无遮挡),开对 0',
    sh.clickableTiles().join(',') === '0,1,2,3,4' && sh.opens() === 0 && !sh.isCleared() && !sh.isDead());
  check('拿 0 开 X 对:opens 1、elementOpen(X);再拿 1 闭对:opens 0',
    sh.pick(0) === false && sh.opens() === 1 && sh.elementOpen('X')
    && sh.pick(1) === true && sh.opens() === 0 && !sh.elementOpen('X'));
  check('闭对后可点集只剩孤儿 {2,3,4}(X 已离场)',
    sh.clickableTiles().join(',') === '2,3,4');
  check('清盘判定:剩 3 孤儿全拿后 |R|=5 但 opens 3 → 未清盘、死局(板侧 no_clickable 同构)',
    sh.pick(2) === false && sh.pick(3) === false && sh.pick(4) === false
    && sh.removedCount() === 5 && sh.opens() === 3
    && !sh.isCleared() && sh.isDead());
  [4, 3, 2, 1, 0].forEach(id => sh.undo(id));
  check('回退免费:按逆序 undo 全部 → 回到开局(clickable / opens / removedCount 全等)',
    sh.removedCount() === 0 && sh.opens() === 0 && sh.clickableTiles().join(',') === '0,1,2,3,4');
}
{
  // E2 遮挡解锁 + P1 单调 + 容量下闭对恒合法
  //   牌:X(0)@(16,2,L0) 顶层;X(1)@(0,2,L0) 被 A(2)@(0,12,L1) 压(同 FS3 几何)
  const b = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  const sh = shadowOf(b);
  const before = sh.clickableTiles();
  check('前置:X(1) 被压不在可点集;可点 = {0, 2}',
    before.join(',') === '0,2' && !sh.isClickable(1));
  check('P1 单调:拿 2 解锁 1;在板诸牌可点性不减(拿掉的 2 自身离场)',
    sh.pick(2) === false && sh.isClickable(1)
    && before.filter(id => id !== 2).every(id => sh.isClickable(id)));
  check('容量语义:opens 1 < 上限 3 → 开 X 对合法(拿 1,opens 2)',
    sh.canPick(1) && sh.pick(1) === false && sh.opens() === 2);
  check('闭对恒合法:opens 2 → 拿 0 闭 X(合法性不随 opens 收紧)',
    sh.pick(0) === true && sh.opens() === 1);
  check('终局:全部入影但 A 滞留(opens 1)→ 未清盘、死局 = 板侧 pile 空',
    sh.isDead() && !sh.isCleared());
}
{
  // E3 容量与死局:3 开无闭 = 影子死局 = 真局「任何一拿都判负」
  //   牌:X(0) 顶层;X(1) 被 P(5) 压;A(2) B(3) C(4) 三个孤儿——全顶层/被压者唯一
  const b = new Board(level(64, 24, [['X', 0, 2, 0], ['X', 8, 2, 0], ['A', 16, 2, 0], ['B', 24, 2, 0], ['C', 32, 2, 0], ['P', 8, 12, 1]]));
  const sh = shadowOf(b);
  check('前置:拿 A B C 开满 3 对(opens 3 = SLOT_COUNT - 1;Board 同步驱动)',
    sh.pick(2) === false && sh.pick(3) === false && sh.pick(4) === false && sh.opens() === SLOT_COUNT - 1
    && (() => { [2, 3, 4].forEach(id => b.pick(id)); return b.slotCount() === 3 && !b.findSlotPair(); })());
  check('死局:可点只剩两个 X 的开新对着 → 全部非法,无合法着',
    sh.isDead() && sh.clickableTiles().length > 0 && sh.legalMoves().length === 0);
  check('非法着 = 真局判负着:影子拒绝拿 0(开 X);真局若强拿则槽满无对判负',
    sh.canPick(0) === false && sh.pick(0) === null && sh.opens() === 3
    && (() => { const p = b.pick(0); const lost = b.isSlotFull() && !b.findSlotPair(); return p.ok && lost; })());
  [4, 3, 2].forEach(id => sh.undo(id));
  check('同一结构不必然死:undo 回 0 开后按 0 开 X → 5 开 P → 1 闭 X 推进——死局只由「3 开无闭」构成',
    sh.opens() === 0 && sh.pick(0) === false && sh.pick(5) === false && sh.pick(1) === true);
}
{
  // E4 中盘接管:从真实对局中途以 R = 非 pile 牌构建影子,与 Board 状态一致
  const b = new Board(level(64, 14, [['X', 8, 2, 0], ['X', 16, 2, 0], ['A', 24, 2, 0], ['B', 32, 2, 0], ['C', 40, 2, 0], ['D', 48, 2, 0], ['D', 56, 2, 0]]));
  b.pick(2); b.pick(0);                                   // A 开、X 开
  const r = new Set(b.allTiles().filter(t => t.status !== 'pile').map(t => t.tileId));
  const sh = shadowOf(b, r);
  check('接管:opens = 槽内张数 2;elementOpen(X)/elementOpen(A) 各半张;可点集与 Board 一致',
    sh.opens() === b.slotCount() && sh.elementOpen('X') && sh.elementOpen('A')
    && sh.clickableTiles().join(',') === b.clickableTiles().map(t => t.tileId).join(','));
  check('接管后续命:拿 1 闭 X(opens 1)、拿 3 闭…(B 无对开 B)→ 状态连续推进',
    sh.pick(1) === true && sh.opens() === 1 && sh.pick(3) === false && sh.opens() === 2);
}
{
  // P 性质:随机盘 lockstep 等价(主网)——驱动器 = 默认梯(与代理同源,保证覆盖清盘分支):
  //   每节点核对 可点集相等 / opens=槽内张数 / 闭对判定一致;
  //   梯选中影子的非法着(3 开时的开新对)= 真局判负着 → 两侧一致判死收局
  const els14 = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const bad = [];
  let steps = 0, cleared = 0, deadByCapacity = 0, deadByEmpty = 0, illegalEnds = 0;
  for (let g = 0; g < 40; g++) {
    const b = new Board(buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els14, seed: 1000 + g }));
    const sh = shadowOf(b);
    let guard = 0;
    while (!sh.isCleared() && !sh.isDead() && guard < 400) {
      guard++;
      const view = perceive(b);
      const analysis = analyze(view);
      const ctx = { view, analysis, clickable: view.perceived.filter(t => analysis.derived.get(t.tileId)?.clickable === true), rng: () => 0.42 };
      const op = decideByLadder(defaultLadder, ctx);
      const t = op.action.tileId;
      const illegal = !sh.canPick(t);
      const closed = illegal ? null : sh.pick(t);
      const p = b.pick(t);
      if (p.paired) { b.eliminate(p.paired[0], p.paired[1]); b.compactSlots(); }
      steps++;
      const where = `盘${g} 步${steps} 拿${t}`;
      if (illegal) {
        // 影子拒着 = 3 开时的开新对;真局这一拿应恰好打满判负
        illegalEnds++;
        if (!(sh.opens() === SLOT_COUNT - 1 && p.ok && b.isSlotFull() && !b.findSlotPair())) {
          bad.push(`${where}:影子拒着但真局不是判负着(opens ${sh.opens()} ok ${p.ok} 槽 ${b.slotCount()})`);
        }
        break;
      }
      if (!p.ok || !!p.paired !== closed) { bad.push(`${where}:闭对判定 影子${closed} ≠ Board ${JSON.stringify(p)}`); break; }
      if (sh.opens() !== b.slotCount()) { bad.push(`${where}:opens ${sh.opens()} ≠ 槽内 ${b.slotCount()}`); break; }
      const sClick = sh.clickableTiles().join(',');
      const bClick = b.clickableTiles().map(x => x.tileId).join(',');
      if (sClick !== bClick) { bad.push(`${where}:可点集 影子[${sClick}] ≠ 板[${bClick}]`); break; }
      if (sh.opens() < SLOT_COUNT - 1 && sh.legalMoves().length === 0 && !sh.isCleared()) {
        bad.push(`${where}:开对未满却无合法着(P1 保证必有可点牌)`); break;
      }
    }
    if (sh.isCleared()) {
      cleared++;
      if (!b.isCleared()) bad.push(`盘${g}:影子清盘但 Board 未清盘`);
    } else if (sh.isDead()) {
      const boardStuck = b.clickableTiles().length === 0;
      const boardAnyPickLoses = b.slotCount() === SLOT_COUNT - 1 && !b.findSlotPair();
      if (boardStuck) deadByEmpty++;
      else if (boardAnyPickLoses) deadByCapacity++;
      else bad.push(`盘${g}:影子死局但 Board 不在死态(槽${b.slotCount()} 闭对${!!b.findSlotPair()} 可点${b.clickableTiles().length})`);
    } else {
      bad.push(`盘${g}:守卫耗尽仍未终局(步数上限)`);
    }
  }
  check(`性质:40 盘默认梯 lockstep ${steps} 步零分歧(可点集/闭对/开对/终局分类;清盘 ${cleared}、容量死局 ${deadByCapacity}〔其中拒着收局 ${illegalEnds}〕、掏空死局 ${deadByEmpty})`,
    bad.length === 0 && cleared > 0 && deadByCapacity + deadByEmpty > 0,
    bad.slice(0, 3).join('\n       '));
}
{
  // P 性质:undo 随机回滚——任意合法序列后逐张逆序 undo,状态与开局全等;
  //   且从同一 R 重建影子与增量维护的结果一致
  const els14 = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const bad = [];
  let rngState = 777;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  for (let g = 0; g < 10; g++) {
    const b = new Board(buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els14, seed: 2000 + g }));
    const sh = shadowOf(b);
    const fresh = shadowOf(b);
    const picked = [];
    for (let k = 0; k < 12; k++) {
      const legal = sh.legalMoves();
      if (legal.length === 0) break;
      const t = legal[Math.floor(rng() * legal.length)];
      sh.pick(t);
      picked.push(t);
    }
    const mid = { opens: sh.opens(), click: sh.clickableTiles().join(','), n: sh.removedCount() };
    const clone = sh.clone();
    if (clone.opens() !== mid.opens || clone.clickableTiles().join(',') !== mid.click || clone.removedCount() !== mid.n) {
      bad.push(`盘${g}:clone 与原状态不一致`);
      continue;
    }
    picked.slice().reverse().forEach(id => sh.undo(id));
    if (sh.opens() !== 0 || sh.removedCount() !== 0 || sh.clickableTiles().join(',') !== fresh.clickableTiles().join(',')) {
      bad.push(`盘${g}:undo 后未还原(opens ${sh.opens()} n ${sh.removedCount()})`);
    }
  }
  check('性质:10 盘随机 12 步 → 逆序 undo 全部还原(opens / removedCount / 可点集)', bad.length === 0,
    bad.slice(0, 2).join('\n       '));
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
if (fail > 0) process.exit(1);
