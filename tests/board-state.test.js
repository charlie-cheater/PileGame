// ============================================================================
// board-state.test.js — Board 状态机回归:派生态 / 可见性 与全量重算逐值一致(node 直跑)
//
// Board 自 2026-11-24 起不再每次操作后全量重算:pick 之后只重算被拿走那张牌直接
// 压着的牌,eliminate 之后不重算。本套测试把 Board 维护的状态与「对当前 allTiles()
// 做全量重算」的参照逐步核对,覆盖 pick / eliminate / recall / shuffle / 非法操作,
// 盘面取自 test_layout、金字塔、随机堆叠布局,以及同层允许重叠的合成盘。
//
// 编译(纯逻辑 core,无 cc 依赖):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/board-state.test.js
//
// 可选(改动前后的 A/B,临时核验用):设环境变量 PILEGAME_BOARD_BASELINE=<temp 下的
//   编译树名>,则另取该树的 Board 与被测 Board 同步走同一串操作、逐步比对全部状态。
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const path = require('path');
const { Board } = require('../temp/v3check/core/Board');
const { computeOcclusion } = require('../temp/v3check/core/Occlusion');
const { computeVisibleState } = require('../temp/v3check/core/Visibility');
const { fillSlots, buildFilledLevel } = require('../temp/v3check/core/RandomFill');
const { buildLevel, lcg } = require('../temp/v3check/core/LevelBuilder');
const { generateLayout } = require('../temp/v3check/core/LayoutGen');
const { canPair } = require('../temp/v3check/core/tile');

const BASELINE = process.env.PILEGAME_BOARD_BASELINE
  ? require(path.join(__dirname, '..', 'temp', process.env.PILEGAME_BOARD_BASELINE, 'core', 'Board')).Board
  : null;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}

const clone = x => JSON.parse(JSON.stringify(x));
const mkEls = n => Array.from({ length: n }, (_, i) =>
  ({ elementId: 'u' + (i + 1), displayName: '元素' + (i + 1), color: '#fff' }));
const ids = tiles => tiles.map(t => t.tileId);

// ─────────────────────────── 参照核对 ───────────────────────────

const DERIVED_FIELDS = ['blocked', 'clickable', 'faceRect', 'sideRect', 'totalRect'];
const VIS_FIELDS = ['tileId', 'exposedArea', 'exposedRatio', 'fullyExposed', 'fullyCovered'];

/** Board 维护的状态 vs 对 allTiles() 的全量重算(及按槽内牌重找配对)。
 *  一致返回 '',否则返回第一处不一致的描述 */
function deviation(board) {
  const tiles = board.allTiles();
  const refD = computeOcclusion(tiles);
  const refV = computeVisibleState(tiles);

  for (const t of tiles) {
    const a = board.getDerived(t.tileId);
    const b = refD.get(t.tileId);
    if (!a || !b) return `派生态条目缺失:${t.tileId}`;
    for (const f of DERIVED_FIELDS) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
        return `派生态 ${t.tileId}.${f}:${JSON.stringify(a[f])} vs ${JSON.stringify(b[f])}`;
      }
    }
  }
  if (refD.size !== tiles.length) return '参照派生态条目数与牌数不符(测试自身问题)';

  const v = board.getVisibleState();
  const pileIds = tiles.filter(t => t.status === 'pile').map(t => t.tileId);
  if (JSON.stringify([...v.byTile.keys()]) !== JSON.stringify(pileIds)) {
    return '可见性条目的键(含顺序)与牌堆不一致';
  }
  for (const [id, a] of v.byTile) {
    const b = refV.byTile.get(id);
    for (const f of VIS_FIELDS) {
      if (a[f] !== b[f]) return `可见性 ${id}.${f}:${a[f]} vs ${b[f]}`;
    }
  }
  if (JSON.stringify(v.exposedIds) !== JSON.stringify(refV.exposedIds)) return 'exposedIds 不一致';
  if (v.totalExposedArea !== refV.totalExposedArea) return '总暴露面积不一致';

  if (JSON.stringify(ids(board.clickableTiles()))
    !== JSON.stringify(tiles.filter(t => refD.get(t.tileId).clickable).map(t => t.tileId))) {
    return 'clickableTiles 与参照不一致';
  }
  const slot = board.slotTiles();
  let refPair = null;
  for (let i = 0; i < slot.length && !refPair; i++) {
    for (let j = i + 1; j < slot.length; j++) {
      if (canPair(slot[i], slot[j])) { refPair = [slot[i].slotIndex, slot[j].slotIndex]; break; }
    }
  }
  if (JSON.stringify(board.findSlotPair()) !== JSON.stringify(refPair)) return 'findSlotPair 与参照不一致';
  if (board.isCleared() !== tiles.every(t => t.status === 'eliminated')) return 'isCleared 不一致';
  return '';
}

/** 一块 Board 的全部可观察状态(序列化;Map 按键序展开)——新旧 Board 同步比对用 */
function snapshot(b) {
  const v = b.getVisibleState();
  return JSON.stringify({
    tiles: b.allTiles().map(t => [t.tileId, t.status, t.slotIndex, t.gx, t.gy, t.layer, t.subZ]),
    derived: b.allTiles().map(t => [t.tileId, ...DERIVED_FIELDS.map(f => JSON.stringify(b.getDerived(t.tileId)?.[f]))]),
    visible: {
      byTile: [...v.byTile].map(([id, x]) => [id, ...VIS_FIELDS.map(f => x[f])]),
      exposedIds: v.exposedIds,
      total: v.totalExposedArea,
    },
    clickable: ids(b.clickableTiles()),
    slot: b.slotTiles().map(t => [t.tileId, t.slotIndex, t.elementId]),
    pair: b.findSlotPair(),
    cleared: b.isCleared(),
    slotFull: b.isSlotFull(),
  });
}

// ─────────────────────────── 随机操作序列 ───────────────────────────

/** 驱动一局:按剖面随机执行操作,每步之后做参照核对(设了基准时另做新旧比对) */
function playCase(level, seed, prof) {
  const rng = lcg(seed);
  const board = new Board(clone(level), lcg(seed + 7));
  const base = BASELINE ? new BASELINE(clone(level), lcg(seed + 7)) : null;
  const stack = [];                       // 入槽序(驱动侧自记,供撤回)
  const res = { states: 0, ops: {}, bad: [], outcome: 'steps' };
  const bump = k => { res.ops[k] = (res.ops[k] || 0) + 1; };
  const noteBad = msg => { if (res.bad.length < 5) res.bad.push(msg); };

  /** 把一次操作同时施加于被测 Board 与基准 Board,比对返回值,再核对状态 */
  const act = (tag, op) => {
    const r = op(board);
    if (base && JSON.stringify(op(base)) !== JSON.stringify(r)) noteBad(`${tag}:返回值与基准 Board 不同`);
    verify(tag);
    return r;
  };
  const verify = tag => {
    res.states++;
    bump(tag);
    const d = deviation(board);
    if (d) noteBad(`${tag}:${d}`);
    if (base && snapshot(board) !== snapshot(base)) noteBad(`${tag}:状态与基准 Board 不同`);
  };

  // 每局比对的状态数上限(大盘 + 能通关的剖面会对很多步;参照重算贵,封顶控制耗时)
  for (let step = 0; step < 800 && res.states < 160; step++) {
    if (board.isCleared()) { res.outcome = 'cleared'; break; }
    const pair = board.findSlotPair();
    if (pair) {
      // 先按槽位下标记下两张牌(消除后槽位就空了),再消除、紧凑
      const inSlot = board.slotTiles();
      const gone = [inSlot.find(t => t.slotIndex === pair[0])?.tileId, inSlot.find(t => t.slotIndex === pair[1])?.tileId];
      act('eliminate', b => b.eliminate(pair[0], pair[1]));
      for (const id of gone) {
        const i = stack.indexOf(id);
        if (i >= 0) stack.splice(i, 1);
      }
      board.compactSlots();
      if (base) base.compactSlots();
      verify('compact');
      continue;
    }
    if (board.isSlotFull()) { res.outcome = 'slot_full'; break; }
    const clickable = board.clickableTiles();
    if (clickable.length === 0) { res.outcome = 'no_clickable'; break; }

    const roll = rng();
    if (roll < prof.recall && stack.length > 0) {
      if (stack.length >= 2 && rng() < 0.3) {
        // 撤回非栈顶:应被拒绝,状态不变
        const before = snapshot(board);
        const r = act('recall-rejected', b => b.recall(stack[0]));
        if (r !== false) noteBad('recall-rejected:非栈顶撤回未被拒绝');
        if (snapshot(board) !== before) noteBad('recall-rejected:被拒绝的撤回改动了状态');
      } else {
        const top = stack[stack.length - 1];
        const r = act('recall', b => b.recall(top));
        if (r) stack.pop();
      }
      continue;
    }
    if (roll < prof.recall + prof.shuffle) {
      const pileBefore = board.allTiles().filter(t => t.status === 'pile').map(t => t.tileId);
      act('shuffle', b => { b.shuffle(); return 'shuffled'; });
      if (JSON.stringify(board.allTiles().filter(t => t.status === 'pile').map(t => t.tileId)) !== JSON.stringify(pileBefore)) {
        noteBad('shuffle:牌堆成员变了');
      }
      continue;
    }
    if (roll < prof.recall + prof.shuffle + prof.invalid) {
      const blocked = board.allTiles().find(t => t.status === 'pile' && !clickable.some(c => c.tileId === t.tileId));
      const before = snapshot(board);
      if (blocked) {
        const r = act('invalid', b => b.pick(blocked.tileId));
        if (!r || r.ok || r.reason !== 'not_clickable') noteBad(`invalid:拿被压的牌返回了 ${JSON.stringify(r)}`);
      }
      const r404 = act('invalid', b => b.pick(99999));
      if (!r404 || r404.ok || r404.reason !== 'not_found') noteBad(`invalid:拿不存在的牌返回了 ${JSON.stringify(r404)}`);
      if (board.slotTiles().length >= 1) {
        const rBad = act('invalid', b => b.eliminate(0, 3));
        if (rBad !== false) noteBad('invalid:不成对的 eliminate 未返回 false');
      }
      if (snapshot(board) !== before) noteBad('invalid:被拒绝的操作改动了状态');
      continue;
    }
    // smart:能闭合槽内半张的先拿(对局走得深,覆盖大量消除后的盘面)
    const slotElems = new Set(board.slotTiles().map(t => t.elementId));
    const closing = prof.smart ? clickable.filter(c => slotElems.has(c.elementId)) : [];
    const pool = closing.length > 0 ? closing : clickable;
    const t = pool[Math.floor(rng() * pool.length)];
    const r = act('pick', b => b.pick(t.tileId));
    if (r.ok) stack.push(t.tileId);
  }
  if (res.outcome === 'steps') res.outcome = res.states >= 160 ? 'capped' : 'step_limit';
  return res;
}

// ─────────────────────────── 关卡语料 ───────────────────────────

/** 同层允许重叠的合成盘:压住「同层按 subZ / tileId 前后序」的边——
 *  LayoutGen 的占据模型不会生成的形态,增量刷新也必须正确处理 */
function overlappingLevel(seed, count, layers, w, h) {
  const rng = lcg(seed);
  const els = mkEls(Math.max(1, Math.round(count / 4)));
  const tiles = [];
  for (let i = 0; i < count / 2; i++) {
    const e = els[Math.floor(rng() * els.length)];
    for (let k = 0; k < 2; k++) {
      tiles.push({
        elementId: e.elementId, variant: 'FULL',
        gx: Math.floor(rng() * (w - 8 + 1)),
        gy: 2 + Math.floor(rng() * (h - 2 - 10 + 1)),
        layer: Math.floor(rng() * layers),
      });
    }
  }
  return { board: { w, h }, elements: els, tiles };
}

function corpus() {
  const families = [];
  const add = (family, name, level, profiles) => families.push({ family, name, level, profiles });
  for (let i = 0; i < 8; i++) {
    const els = mkEls(i % 5 < 3 ? 7 : i % 5 === 3 ? 14 : 35);
    add('test_layout', `test_layout × ${els.length} 元素 #${i}`,
      buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed: 5000 + i }));
  }
  for (const [cols, rows, layers, seed] of [[5, 5, 4, 42], [6, 5, 4, 7], [6, 7, 4, 3], [4, 5, 3, 11]]) {
    add('金字塔', `金字塔 ${cols}×${rows}×${layers}`,
      buildLevel({ pattern: { kind: 'pyramid', cols, rows, layers }, elements: mkEls(9), seed }));
  }
  // 随机堆叠:同编辑器 LayoutPreview 的生成配置(占据模型:同层零重叠),几种盘面尺寸;
  // 个别种子撒不出来属正常,跳过。编辑器那种大盘(配置 0)参照重算很慢,只跑纯对局剖面
  const layoutCfgs = [
    { board: { w: 88, h: 80 }, layers: 4, fillMode: 'capacity', step: { x: 4, y: 5 } },
    { board: { w: 44, h: 40 }, layers: 3, fillMode: 'capacity', step: { x: 4, y: 5 } },
    { board: { w: 60, h: 50 }, layers: 4, targetTiles: 30 },
  ];
  let randomBuilt = 0;
  layoutCfgs.forEach((cfg, ci) => {
    for (const s of ci === 0 ? [0, 1] : [0, 1, 2]) {
      try {
        const els = mkEls(7);
        const r = generateLayout({ ...cfg, seed: 900 + ci * 10 + s });
        add('随机堆叠', `随机堆叠 配置${ci} #${s}(${r.slots.length} 张)`,
          { board: cfg.board, elements: els, tiles: fillSlots(r.slots, { elements: els, seed: s + 1 }) },
          ci === 0 ? [PROFILES[0]] : undefined);
        randomBuilt++;
      } catch {
        // 该配置该种子撒不出来:跳过
      }
    }
  });
  if (randomBuilt < 3) throw new Error(`随机堆叠布局生成成功的太少(${randomBuilt} 个)`);
  for (let i = 0; i < 8; i++) add('同层重叠', `同层重叠 #${i}`, overlappingLevel(300 + i, 24, 3, 20, 28));
  return families;
}

const PROFILES = [
  { name: '纯对局(只 pick / eliminate,同 Runner 与 GameController)', recall: 0, shuffle: 0, invalid: 0 },
  { name: '纯对局·能闭对先拿', recall: 0, shuffle: 0, invalid: 0, smart: true },
  { name: '含撤回 20% + 洗牌 8% + 非法操作 5%', recall: 0.2, shuffle: 0.08, invalid: 0.05 },
];

console.log('— 参照核对:每个操作之后与全量重算逐值一致 —');
{
  const families = corpus();
  const byFamily = new Map();
  let seed = 7000;
  for (const f of families) {
    const t0 = Date.now();
    const agg = byFamily.get(f.family) ?? { states: 0, ops: {}, bad: [], games: 0, cleared: 0, capped: 0, ms: 0 };
    byFamily.set(f.family, agg);
    for (const prof of f.profiles ?? PROFILES) {
      const r = playCase(f.level, seed++, prof);
      agg.games++;
      if (r.outcome === 'cleared') agg.cleared++;
      if (r.outcome === 'capped') agg.capped++;
      agg.states += r.states;
      for (const [k, v] of Object.entries(r.ops)) agg.ops[k] = (agg.ops[k] || 0) + v;
      for (const b of r.bad) agg.bad.push(`${f.name} / ${prof.name}:${b}`);
    }
    agg.ms += Date.now() - t0;
  }
  for (const [family, a] of byFamily) {
    const ops = Object.entries(a.ops).map(([k, v]) => `${k} ${v}`).join(' · ');
    check(`${family}:${a.games} 局 ${a.states} 个状态逐值一致(通关 ${a.cleared}`
      + `${a.capped ? ` · 到步数上限 ${a.capped}` : ''};${ops};${(a.ms / 1000).toFixed(1)} s)`,
      a.bad.length === 0, a.bad.slice(0, 3).join(' | '));
  }
  if (BASELINE) {
    console.log(`    (已与基准 Board 同步比对:${process.env.PILEGAME_BOARD_BASELINE})`);
  }
}

// ─────────────────────────── 场景断言 ───────────────────────────

/** 手搭小关卡:tiles = [elementId, gx, gy, layer] */
function smallLevel(...tiles) {
  const elements = [...new Set(tiles.map(t => t[0]))].map(id => ({ elementId: id, displayName: id, color: '#fff' }));
  return {
    board: { w: 30, h: 20 },
    elements,
    tiles: tiles.map(([elementId, gx, gy, layer]) => ({ elementId, variant: 'FULL', gx, gy, layer })),
  };
}

console.log('— 场景:压住 / 揭露 / 消除 / 撤回 —');
{
  // X(e1,L0) 被 Y(e2,L1) 整张盖住;Z(e1,L0) 在旁边
  const level = smallLevel(['e1', 0, 2, 0], ['e2', 0, 2, 1], ['e1', 9, 2, 0]);
  const board = new Board(clone(level));
  check('开局:被整张盖住的 X 不可点,Y / Z 可点(与全量重算一致)',
    JSON.stringify(ids(board.clickableTiles())) === '[1,2]' && deviation(board) === '',
    ids(board.clickableTiles()).join(','));

  const r = board.pick(1);   // 拿走 Y
  check('拿走 Y:X 被揭露为可点;Y 自身不可点;可见性里不再有 Y',
    r.ok && !r.paired
    && board.getDerived(0).clickable === true && board.getDerived(0).blocked === false
    && board.getDerived(1).clickable === false && board.getDerived(1).blocked === false
    && !board.getVisibleState().byTile.has(1)
    && board.getVisibleState().byTile.get(0).fullyExposed === true
    && deviation(board) === '', deviation(board));

  const snapBefore = board.getVisibleState();
  const d0 = board.getDerived(0);
  board.pick(0);             // 拿 X:槽内 [Y, X],不成对
  check('拿 X:槽内 Y(e2) + X(e1) 不成对',
    board.findSlotPair() === null && board.slotCount() === 2 && deviation(board) === '', deviation(board));
  check('取走的状态是快照:操作之后,先前的可见性 / 派生态对象内容不变,且已不是当前对象',
    board.getVisibleState() !== snapBefore
    && snapBefore.byTile.has(0) === true                 // 旧快照里 X 仍在牌堆
    && board.getVisibleState().byTile.has(0) === false
    && d0.clickable === true && board.getDerived(0) !== d0
    && board.getDerived(0).clickable === false);

  check('撤回非栈顶(Y)被拒绝,状态不变',
    board.recall(1) === false && board.getTile(1).status === 'slot' && deviation(board) === '', deviation(board));
  check('撤回栈顶(X):X 回到牌堆且可点(撤回走全量重算)',
    board.recall(0) === true && board.getTile(0).status === 'pile'
    && board.getDerived(0).clickable === true && deviation(board) === '', deviation(board));

  board.pick(0);             // 再拿 X:槽内 [Y, X]
  const r3 = board.pick(2);  // 拿 Z:与 X 成对
  check('拿 Z:与槽内的 X 成对,返回槽位下标 [1, 2]',
    r3.ok && JSON.stringify(r3.paired) === '[1,2]' && deviation(board) === '', deviation(board));
  const visRef = board.getVisibleState();
  const r4 = board.eliminate(1, 2);
  check('消除 X / Z:成功,两张离场;牌堆没变,可见性对象原样(不再重算)',
    r4 === true && board.getTile(0).status === 'eliminated' && board.getTile(2).status === 'eliminated'
    && board.getVisibleState() === visRef && deviation(board) === '', deviation(board));
  check('消除后仍能继续:槽内剩 Y(e2),无可点成对;Y 的派生态为不可点',
    board.findSlotPair() === null && board.slotCount() === 1
    && board.getDerived(1).clickable === false && deviation(board) === '');
}

console.log('— 场景:同层重叠(前后序边)—');
{
  // P(e1) 与 Q(e2) 同在 L0 且重叠:Q 的 tileId 大,在同层里排在前,盖住 P 的 x∈[3,8](50)
  const level = smallLevel(['e1', 0, 2, 0], ['e2', 3, 2, 0]);
  const board = new Board(clone(level));
  const p0 = board.getVisibleState().byTile.get(0);
  check('开局:P 被同层的 Q 盖住 50(顶面 80,暴露 30)不可点;Q 完全暴露可点',
    !board.getDerived(0).clickable && p0.exposedArea === 30 && p0.fullyExposed === false
    && board.getDerived(1).clickable === true
    && board.getVisibleState().byTile.get(1).fullyExposed === true
    && deviation(board) === '', JSON.stringify(p0));
  board.pick(1);
  check('拿走 Q:P 完全暴露且可点(与全量重算一致)',
    board.getDerived(0).clickable === true && board.getVisibleState().byTile.get(0).fullyExposed === true
    && deviation(board) === '', deviation(board));
}

console.log('— 场景:洗牌与非法操作 —');
{
  const board = new Board(clone(buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: mkEls(7), seed: 21 })), lcg(5));
  board.pick(ids(board.clickableTiles())[0]);
  const before = board.allTiles().map(t => [t.tileId, t.status, t.layer]);
  const places = board.allTiles().filter(t => t.status === 'pile').map(t => `${t.layer}:${t.gx},${t.gy}`).sort();
  board.shuffle();
  check('洗牌:牌堆成员不变,每层的(层,位置)集合不变;状态与全量重算一致',
    JSON.stringify(board.allTiles().map(t => [t.tileId, t.status, t.layer])) === JSON.stringify(before)
    && JSON.stringify(board.allTiles().filter(t => t.status === 'pile').map(t => `${t.layer}:${t.gx},${t.gy}`).sort()) === JSON.stringify(places)
    && deviation(board) === '', deviation(board));
  const picked = ids(board.clickableTiles())[0];
  const r = board.pick(picked);
  check('洗牌后继续拾取:成功且状态与全量重算一致', r.ok && deviation(board) === '', deviation(board));
  check('洗牌后撤回栈顶(刚拿的那张):成功且状态与全量重算一致',
    board.recall(picked) === true && board.getTile(picked).status === 'pile'
    && deviation(board) === '', deviation(board));
  const d = snapshot(board);
  check('拿不存在的牌:not_found;状态不变',
    JSON.stringify(board.pick(9999)) === '{"ok":false,"reason":"not_found"}' && snapshot(board) === d);
  const blocked = board.allTiles().find(t => t.status === 'pile' && !board.getDerived(t.tileId).clickable);
  check('拿被压的牌:not_clickable;状态不变',
    !!blocked && JSON.stringify(board.pick(blocked.tileId)) === '{"ok":false,"reason":"not_clickable"}'
    && snapshot(board) === d);
  check('不成对的 eliminate:返回 false;状态不变',
    board.eliminate(0, 3) === false && snapshot(board) === d);
}

console.log('— 场景:通关 —');
{
  const board = new Board(clone(smallLevel(['e1', 0, 2, 0], ['e1', 9, 2, 0])));
  const a = board.pick(0);
  const b = board.pick(1);
  check('两张同元素:第二张入槽即成对', a.ok && !a.paired && b.ok && JSON.stringify(b.paired) === '[0,1]'
    && deviation(board) === '');
  board.eliminate(0, 1);
  board.compactSlots();
  check('消除后清空:isCleared;无可点牌;可见性为空',
    board.isCleared() && board.clickableTiles().length === 0
    && board.getVisibleState().byTile.size === 0 && board.getVisibleState().exposedIds.length === 0
    && board.getVisibleState().totalExposedArea === 0 && deviation(board) === '');
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
