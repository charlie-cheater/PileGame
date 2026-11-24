// ============================================================================
// agent-perception.test.js — 代理 ①感知/②分析 回归测试(node 直跑,不依赖 cc)
//
// 统一测试盘面:编辑器当前布局 assets/data/layouts/test_layout.json
// + 随机填充 seed 7(与 LayoutPreview 预览完全一致)
//
// 编译(纯逻辑文件,无 cc 依赖):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Ladder.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/agent-perception.test.js
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const { Board } = require('../temp/v3check/core/Board');
const { computeDepths } = require('../temp/v3check/core/Depth');
const { coversAny, computeOcclusion } = require('../temp/v3check/core/Occlusion');
const { fillSlots } = require('../temp/v3check/core/RandomFill');
const { buildMahjongElements } = require('../temp/v3check/core/MahjongSet');
const { lcg } = require('../temp/v3check/core/LevelBuilder');
const { perceive, UNKNOWN_ELEMENT } = require('../temp/v3check/agent/Perception');
const { analyze, analyzeStructure, simulateReveal } = require('../temp/v3check/agent/Analysis');
const { decideByLadder, defaultLadder } = require('../temp/v3check/agent/Ladder');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}

/** 主观可点性对真值的对账(v3 等价定理:期望恒空)。对账属验收,在测试侧做——
 *  AnalysisResult 保持纯主观,不接收真值(2026-11-23 移除 clickConflicts) */
function clickConflicts(board, view, result) {
  return view.perceived
    .filter(t => result.derived.get(t.tileId)?.clickable !== board.getDerived(t.tileId)?.clickable)
    .map(t => t.tileId);
}

/** 编辑器盘面:test_layout.json + 27 牌型随机填充(默认 seed 7,与预览一致) */
function buildEditorBoard(fillSeed = 7) {
  const elements = buildMahjongElements();
  const tiles = fillSlots(LAYOUT.tiles, { elements, seed: fillSeed });
  return new Board({ board: LAYOUT.board, elements, tiles });
}

console.log('— 感知边界 —');
{
  const board = buildEditorBoard();
  const view = perceive(board);
  const real = board.getVisibleState();

  const visibleIds = new Set(
    board.allTiles().filter(t => t.status === 'pile' && real.byTile.get(t.tileId).exposedArea > 0).map(t => t.tileId));
  check('感知集 = 有可见像素的 pile 牌',
    view.perceived.length === visibleIds.size &&
    view.perceived.every(t => visibleIds.has(t.tileId)),
    `perceived ${view.perceived.length} vs visible ${visibleIds.size}`);
  check('隐藏牌(exposedArea=0)不进感知集', view.perceived.length < board.pileCount(),
    `${view.perceived.length}/${board.pileCount()}`);
  check('总数统计与真实 pile 数一致', view.totalPileCount === board.pileCount());

  const masked = view.perceived.filter(t => t.elementId === UNKNOWN_ELEMENT);
  const expectMasked = [...visibleIds].filter(id => real.byTile.get(id).exposedRatio < 0.25);
  check(`身份遮蔽 = 暴露比例 < 阈值(未识别 ${masked.length} 张)`,
    masked.length === expectMasked.length &&
    masked.every(t => real.byTile.get(t.tileId).exposedRatio < 0.25));
  check('未识别牌拷贝隔离(不泄漏真实 elementId)',
    masked.every(t => {
      const realTile = board.getTile(t.tileId);
      return t !== realTile && (t.elementId === UNKNOWN_ELEMENT || t.elementId === realTile.elementId);
    }));
  check('开局槽为空', view.slot.length === 0);
}

console.log('— 分析:遮挡关系 / 深度 / 可点性 —');
{
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  // 2026-11-24:遮挡边 / 深度 / 揭露效能③决策不读,不再随 analyze 计算,
  // 改由 analyzeStructure 按需产出——结构类断言改读它
  const extras = analyzeStructure(view);

  check('analyze 不携带决策不读的三项(edges / depth / reveal)',
    !('edges' in result) && !('depth' in result) && !('reveal' in result));
  check('analyzeStructure 按需产出这三项',
    Array.isArray(extras.edges) && !!extras.depth && !!extras.reveal
    && result.groups !== undefined && result.matches !== undefined);

  const perIds = new Set(view.perceived.map(t => t.tileId));
  check('遮挡边全部落在感知子集内',
    extras.edges.every(e => perIds.has(e.above) && perIds.has(e.below)));

  // 独立复算:感知集上的成对 coversAny(条数与方向逐条一致)
  const expectEdges = new Set();
  for (const a of view.perceived) for (const b of view.perceived) {
    if (a.tileId !== b.tileId && coversAny(a, b)) expectEdges.add(a.tileId + '->' + b.tileId);
  }
  check(`遮挡边 = 感知集上的成对 coversAny(${extras.edges.length} 条,跨层 ${
    extras.edges.filter(e => e.crossLayer).length})`,
    extras.edges.length === expectEdges.size
    && extras.edges.every(e => expectEdges.has(e.above + '->' + e.below)));

  const realEdges = new Set();
  const all = board.allTiles();
  for (const a of all) for (const b of all) {
    if (a.tileId !== b.tileId && coversAny(a, b)) realEdges.add(a.tileId + '->' + b.tileId);
  }
  check(`感知边 ⊆ 真实边(感知 ${extras.edges.length} / 真实 ${realEdges.size})`,
    extras.edges.every(e => realEdges.has(e.above + '->' + e.below)));

  const realDepth = computeDepths(all);
  const subsetDepth = computeDepths(view.perceived);
  check('代理深度 = 感知子集上的 computeDepths(与停算前口径一致)',
    extras.depth.maxDepth === subsetDepth.maxDepth
    && JSON.stringify(extras.depth.waves) === JSON.stringify(subsetDepth.waves)
    && [...subsetDepth.depth].every(([id, d]) => extras.depth.depth.get(id) === d)
    && extras.depth.depth.size === subsetDepth.depth.size);
  check('代理深度 ≤ 真实深度(感知子图的下界)',
    view.perceived.every(t =>
      (extras.depth.depth.get(t.tileId) ?? 0) <= (realDepth.depth.get(t.tileId) ?? 0)));

  const conflicts = clickConflicts(board, view, result);
  check('v3 等价定理:主观可点性与真值零冲突', conflicts.length === 0,
    `conflicts: ${conflicts.join(',')}`);
  const subjectiveClickable = view.perceived.filter(t => result.derived.get(t.tileId).clickable).length;
  const realClickable = board.clickableTiles().length;
  check(`主观可点数 = 真实可点数(${subjectiveClickable})`, subjectiveClickable === realClickable);
  check('blockersOf / occludesOf 与边集一致(决策路径仍保留这两份)',
    extras.edges.every(e => (result.blockersOf.get(e.below) || []).includes(e.above))
    && extras.edges.every(e => (result.occludesOf.get(e.above) || []).includes(e.below)));
}

console.log('— 分析去重:同一次分析内不重复计算,产出逐项不变(2026-11-24)—');
{
  const { buildOcclusionTopology } = require('../temp/v3check/core/OcclusionTopology');
  // 独立参照 = 去重之前的做法:遮挡邻接来自 coversAny 成对循环,
  // 闭包大小来自 OcclusionTopology.allBlockers 的长度
  const legacyAdjacency = (perceived) => {
    const blockersOf = new Map(perceived.map(t => [t.tileId, []]));
    const occludesOf = new Map(perceived.map(t => [t.tileId, []]));
    for (let i = 0; i < perceived.length; i++) {
      for (let j = i + 1; j < perceived.length; j++) {
        const a = perceived[i], b = perceived[j];
        if (coversAny(a, b)) {
          blockersOf.get(b.tileId).push(a.tileId);
          occludesOf.get(a.tileId).push(b.tileId);
        } else if (coversAny(b, a)) {
          blockersOf.get(a.tileId).push(b.tileId);
          occludesOf.get(b.tileId).push(a.tileId);
        }
      }
    }
    return { blockersOf, occludesOf };
  };
  // 键、值、顺序逐项比(邻接列表按感知序——消费端不依赖这个顺序,
  // 保持一致是为了改动前后逐项相同)
  const sameMap = (a, b) => a.size === b.size && JSON.stringify([...a]) === JSON.stringify([...b]);

  const verify = (view, label) => {
    const r = analyze(view);
    const legacy = legacyAdjacency(view.perceived);
    const topo = buildOcclusionTopology(view.perceived);
    let closureOk = r.closureSize.size === view.perceived.length;
    for (const t of view.perceived) {
      if (r.closureSize.get(t.tileId) !== (topo.allBlockers.get(t.tileId) ?? []).length) closureOk = false;
    }
    check(`${label}:邻接表 = 原先的成对循环(键序与列表顺序逐项一致)`,
      sameMap(r.blockersOf, legacy.blockersOf) && sameMap(r.occludesOf, legacy.occludesOf));
    check(`${label}:闭包大小 = 遮挡拓扑的闭包长度(全部 ${view.perceived.length} 张感知牌)`, closureOk);
  };

  // 编辑器盘:开局 + 拾取若干张后的中盘(槽内有牌)
  const board = buildEditorBoard();
  verify(perceive(board), '编辑器盘开局');
  let picked = 0;
  for (let i = 0; i < 20 && !board.isSlotFull(); i++) {
    const clickable = board.clickableTiles();
    const r = board.pick(clickable[i % clickable.length].tileId);
    if (!r.ok) break;
    picked++;
    if (r.paired) { board.eliminate(r.paired[0], r.paired[1]); board.compactSlots(); }
  }
  const mid = perceive(board);
  verify(mid, `编辑器盘拾取 ${picked} 张后`);
  check(`编辑器盘中盘确有槽内牌(${mid.slot.length} 张)且邻接非空(用例有效)`,
    mid.slot.length > 0
    && [...analyze(mid).occludesOf.values()].reduce((s, l) => s + l.length, 0) > 0);

  // 合成盘:感知序 ≠ tileId 升序——邻接列表仍按感知序(同层牌互不重叠)。
  // L0:牌 7 (0,10)、牌 1 (9,10);L1:牌 3 (4,10) 压着 7 与 1,牌 9 (4,22);
  // L2:牌 2 (4,16) 连侧面压着 3、9、7、1
  const mkS = (tileId, gx, gy, layer) =>
    ({ elementId: 'x', variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const shuffled = {
    perceived: [mkS(3, 4, 10, 1), mkS(1, 9, 10, 0), mkS(7, 0, 10, 0), mkS(9, 4, 22, 1), mkS(2, 4, 16, 2)],
    slot: [], exposure: new Map(), totalPileCount: 5,
  };
  verify(shuffled, '感知序打乱的合成盘');
  const sa = analyze(shuffled);
  check('合成盘用例有效:遮挡邻接 6 条;牌 2 压着的四张按感知序为 [3, 1, 7, 9](非 tileId 升序)',
    JSON.stringify(sa.occludesOf.get(2)) === '[3,1,7,9]'
    && [...sa.occludesOf.values()].reduce((s, l) => s + l.length, 0) === 6
    && JSON.stringify(sa.blockersOf.get(7)) === '[3,2]');
}

console.log('— 动态:拾取后感知单调增长 —');
{
  const board = buildEditorBoard();
  const v1 = perceive(board);
  const ids1 = new Set(v1.perceived.map(t => t.tileId));

  const pick = board.clickableTiles()[0];
  board.pick(pick.tileId);

  const v2 = perceive(board);
  const ids2 = new Set(v2.perceived.map(t => t.tileId));
  const remain = [...ids1].filter(id => id !== pick.tileId);   // 被拾取牌离堆入槽,不计
  check('拾取后感知集只增不减(P1 投影,剔除被拾取牌)',
    remain.every(id => ids2.has(id)) && ids2.size >= remain.length,
    `before ${ids1.size} after ${ids2.size}`);
  check('入槽牌出现在 slot(身份不遮蔽)',
    v2.slot.length === 1 && v2.slot[0].tileId === pick.tileId && v2.slot[0].elementId === pick.elementId);

  const r2 = analyze(v2);
  check('拾取后可点性仍零冲突', clickConflicts(board, v2, r2).length === 0);
}

console.log('— 分析扩展:同类归组 —');
{
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  const report = result.groups;

  const pileSum = [...report.groups.values()].reduce((s, g) => s + g.pile.length, 0);
  check('守恒:Σ分组pile + 未识别 = 感知数',
    pileSum + report.unknownPileCount === view.perceived.length,
    `${pileSum}+${report.unknownPileCount} vs ${view.perceived.length}`);
  check('识别数口径一致',
    report.identifiedPileCount === view.perceived.length - report.unknownPileCount);

  check('分组键 = 真实 elementId(识别牌无错归)',
    [...report.groups.values()].every(g =>
      g.pile.every(r => board.getTile(r.tileId).elementId === g.elementId)));

  check('记录只含 tileId / clickable(深度随停算移除),可点性与结构分析一致',
    [...report.groups.values()].every(g =>
      g.pile.every(r =>
        Object.keys(r).length === 2 && !('depth' in r)
        && r.clickable === (result.derived.get(r.tileId)?.clickable === true))));

  const multiGroups = [...report.groups.values()].filter(g => g.pile.length >= 2);
  const doubleLit = multiGroups.filter(g => g.pile.filter(r => r.clickable).length >= 2);
  console.log(`    已识别 ${report.identifiedPileCount} 张 / ${report.groups.size} 类`
    + ` · 可见≥2张的类 ${multiGroups.length} · 双亮可完对类 ${doubleLit.length}`);

  // 拾取已识别的可点牌 → 其分组出现槽记录,并离开 pile
  const identifiedClickable = view.perceived.find(
    t => t.elementId !== UNKNOWN_ELEMENT && result.derived.get(t.tileId)?.clickable);
  board.pick(identifiedClickable.tileId);
  const view2 = perceive(board);
  const result2 = analyze(view2);
  const report2 = result2.groups;
  const g2 = report2.groups.get(identifiedClickable.elementId);
  check('拾取后入槽牌计入其分组 slot',
    !!g2 && g2.slot.includes(identifiedClickable.tileId));
  check('入槽牌离开该分组 pile',
    !g2.pile.some(r => r.tileId === identifiedClickable.tileId));
}

console.log('— 分析扩展:揭露效能(独占遮挡口径)—');
{
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  const extras = analyzeStructure(view);
  const util = extras.reveal;

  check('occludesOf 与边集对偶(每条边 above→below 各计一次)',
    extras.edges.every(e => result.occludesOf.get(e.above).includes(e.below))
    && extras.edges.every(e => result.blockersOf.get(e.below).includes(e.above)));

  // 独占 ⊆ 投影相交(结构关系)
  const occludes = new Map();
  extras.edges.forEach(e => {
    if (!occludes.has(e.above)) occludes.set(e.above, new Set());
    occludes.get(e.above).add(e.below);
  });
  check('独占直接遮挡 ⊆ 投影遮挡关系',
    util.exclusivePairs.every(p => occludes.get(p.above)?.has(p.below)));

  // 顶层唯一效能王:L5 五万,独占 4(压着 L4 缝上四张;纯几何,与填充无关)
  const topLayer = Math.max(...LAYOUT.tiles.map(t => t.layer));
  const maxHolders = view.perceived.filter(t => util.count.get(t.tileId) === util.max);
  check(`顶层效能王:唯一最大 ${util.max} 张,且在 L${topLayer}`,
    util.max === 4 && maxHolders.length === 1 && maxHolders[0].layer === topLayer,
    `max=${util.max} holders=${maxHolders.length}`);
  const king = board.getTile(maxHolders[0].tileId);
  const kingTargets = util.exclusivePairs
    .filter(p => p.above === maxHolders[0].tileId)
    .map(p => board.getTile(p.below).elementId).sort();
  check('效能王直接遮挡 = 缝上四张(九万/二条/五饼/四饼)',
    kingTargets.join(',') === 'bam2,dot4,dot5,wan9',
    kingTargets.join(','));

  // 底层(L0)不可能独占遮挡任何人(布局无 subZ)
  check('布局无 subZ,底层牌效能为 0', LAYOUT.tiles.every(t => t.subZ === undefined));
  const bottom = view.perceived.filter(t => t.layer === 0);
  check('底层牌效能为 0', bottom.length > 0 && bottom.every(t => util.count.get(t.tileId) === 0));

  check('独占计数 ≤ 投影计数(冗余被消化)',
    view.perceived.every(t =>
      util.count.get(t.tileId) <= result.occludesOf.get(t.tileId).length));
  console.log(`    效能王 ${king.elementId}@L${king.layer}:投影 ${result.occludesOf.get(maxHolders[0].tileId).length}`
    + ` → 独占 ${util.count.get(maxHolders[0].tileId)}(冗余被消化)`);

  // 独占面积数据(v1.6):pair 分布 + 合计标量的账目对账
  const sumCount = [...util.count.values()].reduce((s, n) => s + n, 0);
  check('独占面积 pair 数 = Σcount,pair 面积均为正整数',
    util.exclusivePairs.length === sumCount
    && util.exclusivePairs.every(p => p.area > 0 && Number.isInteger(p.area)));
  check('area 合计 = 该遮挡者全部 pair 面积之和(键集与 count 一致)',
    util.area.size === util.count.size
    && [...util.area.entries()].every(([id, a]) =>
      a === util.exclusivePairs.filter(p => p.above === id).reduce((s, p) => s + p.area, 0)));
  check('效能王面积 = maxArea(张数王同为此盘的面积王)',
    util.area.get(maxHolders[0].tileId) === util.maxArea && util.maxArea > 0,
    `king area ${util.area.get(maxHolders[0].tileId)} / maxArea ${util.maxArea}`);
  check('底层牌独占面积 = 0(与张数口径一致)',
    bottom.every(t => util.area.get(t.tileId) === 0));

  // 合成盘:张数同权、面积分化 + 完全冗余的最小形态(遮挡者互不盖牌面)
  //   X(L0) 被 P/Q/R 盖:P 盖左带 [0,2](20),R(L2 正对 P 上方)盖同一左带(20)
  //   → P、R 在 X 上互为冗余(独占均 0);Q 盖右带 [3,8](50)独享;
  //   R 同时完全盖住 P 的牌面(80,R 独享)。
  //   ⇒ 张数口径 Q=R=1 同权;面积口径 Q=50 ≠ R=80 分化;P=0/0
  const mkS = (tileId, gx, gy, layer) =>
    ({ elementId: 'x', variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const X = mkS(0, 0, 10, 0);
  const sP = mkS(1, -6, 10, 1);
  const sQ = mkS(2, 3, 10, 1);
  const sR = mkS(3, -6, 10, 2);
  const sv = { perceived: [X, sP, sQ, sR], slot: [], exposure: new Map(), totalPileCount: 4 };
  const sr = analyzeStructure(sv);
  const su = sr.reveal;
  check('合成盘:张数口径 Q=R=1 同权(P 与 R 互为冗余为 0)',
    su.count.get(1) === 0 && su.count.get(2) === 1 && su.count.get(3) === 1,
    `P=${su.count.get(1)} Q=${su.count.get(2)} R=${su.count.get(3)}`);
  check('合成盘:面积口径分化 Q=50 < R=80(unit²),P=0',
    su.area.get(1) === 0 && su.area.get(2) === 50 && su.area.get(3) === 80,
    `P=${su.area.get(1)} Q=${su.area.get(2)} R=${su.area.get(3)}`);
  check('合成盘:pair 分布(Q→X=50;R→P=80;P 无 pair;R 对 X 冗余无 pair)',
    su.exclusivePairs.filter(p => p.above === 1).length === 0
    && su.exclusivePairs.filter(p => p.above === 3 && p.below === 0).length === 0
    && su.exclusivePairs.filter(p => p.above === 2 && p.below === 0)[0].area === 50
    && su.exclusivePairs.filter(p => p.above === 3 && p.below === 1)[0].area === 80);

  // 拾取效能王(顶层可点)后重算正常
  board.pick(maxHolders[0].tileId);
  const view2 = perceive(board);
  const result2 = analyze(view2);
  const util2 = analyzeStructure(view2).reveal;
  check('拾取后效能重算正常(账目规模一致)',
    util2.count.size === view2.perceived.length
    && result2.occludesOf.get(maxHolders[0].tileId) === undefined);
}

console.log('— 分析扩展:揭露闭包(扇入 × 链深的递归展开)—');
{
  const { analyze } = require('../temp/v3check/agent/Analysis');
  const mkS = (tileId, gx, gy, layer) =>
    ({ elementId: 'x', variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });

  // X:被 3 张浅牌同压(扇入 3,链深 0;三张互相不重叠)
  // A 盖左带 [0,3]、B 盖右带 [3,8]、C 高位侧边擦盖顶带 [18,20]
  const X = mkS(0, 0, 10, 0);
  const A = mkS(1, -5, 10, 1), B = mkS(2, 3, 10, 1), C = mkS(3, 0, 20, 1);
  const rx = analyze({ perceived: [X, A, B, C], slot: [], exposure: new Map(), totalPileCount: 4 });
  check('扇入形态:X 闭包 = 3(3 张遮挡者各计 1,旧深度口径只会给 1)',
    rx.closureSize.get(0) === 3, `actual ${rx.closureSize.get(0)}`);
  check('顶层遮挡者闭包 = 0(互不重叠)',
    rx.closureSize.get(1) === 0 && rx.closureSize.get(2) === 0 && rx.closureSize.get(3) === 0,
    `A=${rx.closureSize.get(1)} B=${rx.closureSize.get(2)} C=${rx.closureSize.get(3)}`);

  // Y:单链深埋 3 层(扇入 1,链深 3)
  const Y = mkS(0, 0, 10, 0), D = mkS(1, 0, 10, 1), E = mkS(2, 0, 10, 2), F = mkS(3, 0, 10, 3);
  const ry = analyze({ perceived: [Y, D, E, F], slot: [], exposure: new Map(), totalPileCount: 4 });
  check('链深形态:Y 闭包 = 3({D,E,F} 递归展开,旧扇入口径只会给 1)',
    ry.closureSize.get(0) === 3, `actual ${ry.closureSize.get(0)}`);
  check('链中间闭包递减(D=2, E=1)',
    ry.closureSize.get(1) === 2 && ry.closureSize.get(2) === 1);
}

console.log('— 分析扩展:匹配消耗 v4(消除模拟的净占用峰值)—');
{
  // 手推小盘:每个形态的占用序列与峰值都可逐步验证。
  // 几何约定:牌 8×10、sideH 2;同层牌以 x 间隔 9 并置互不重叠;错开压用同列上下两张
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const an = (tiles, slot = []) => analyze({ perceived: tiles, slot, exposure: new Map(),
    totalPileCount: tiles.length + slot.length });
  const opOf = (tiles, slot) => an(tiles, slot).matches.opportunities.find(o => o.elementId === 'e');
  const seq = (o) => o.cost.occupancy.join(',');

  // T1 double:两张都可点,挖掘区空
  const t1 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 9, 10, 0)]);
  check('T1 double:拿 l(1)→ 拿 t(2)→ 消;峰值 2',
    t1.type === 'double' && seq(t1) === '1,2' && t1.matchCost === 2 && t1.cost.residual.length === 0,
    `occ=${seq(t1)} peak=${t1.matchCost}`);

  // T2 close:槽内已持伴,target 可点(ladder slot-close 的情形)——「至少要有 1 个空槽」
  {
    const held = mkS(9, 'e', 18, 10, 0);
    held.status = 'slot';
    held.slotIndex = 0;
    const t2 = opOf([mkS(0, 'e', 0, 10, 0)], [held]);
    check('T2 close:原有 1 张不计;拿 t(净 1)→ 消;峰值 1(−1 处理由净占用自然得出)',
      t2.type === 'close' && t2.cost.preexisting.join(',') === '9'
        && seq(t2) === '1' && t2.matchCost === 1 && t2.cost.residual.length === 0,
      `pre=${t2.cost.preexisting.join(',')} occ=${seq(t2)} peak=${t2.matchCost}`);
  }

  // T3 hold:target 被 1 张压,遮挡者的伴埋在挖掘区外 → 遮挡器出不去,留 residual
  //   t(0,被 p 压) l(9,可点) p(0,L1 压 t) pMate(18,被 w 压)
  const t3 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 9, 10, 0), mkS(2, 'f', 0, 10, 1),
    mkS(3, 'f', 18, 10, 0), mkS(4, 'z', 18, 10, 1)]);
  check('T3 hold:拿 l(1)→ 拿 p(2)→ 拿 t(3)→ 消 l+t;峰值 3;p 留在剩余',
    t3.type === 'hold' && seq(t3) === '1,2,3' && t3.matchCost === 3
      && t3.cost.residual.join(',') === '2' && t3.cost.steps === 3,
    `occ=${seq(t3)} peak=${t3.matchCost} res=${t3.cost.residual.join(',')}`);
  check('T3 不找被压的伴:pMate 被压 → 不去拿(步数 3,未为 p 追支线)',
    t3.cost.steps === 3 && !t3.cost.occupancy.some(() => false) && t3.cost.residual.length === 1);

  // T4 hold:遮挡者的伴当前可点 → 清槽阶段拿伴,p 走掉
  const t4 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 30, 10, 0), mkS(2, 'f', 0, 10, 1),
    mkS(3, 'f', 40, 10, 0)]);
  check('T4 hold + 伴可点:l(1)→ p(2)→ t(3)→ 消 l+t → 拿 pMate(2)→ 消;峰值 3,槽清空',
    seq(t4) === '1,2,3,2' && t4.matchCost === 3 && t4.cost.residual.length === 0 && t4.cost.steps === 4,
    `occ=${seq(t4)} peak=${t4.matchCost} res=${t4.cost.residual.join(',')}`);

  // T5 dig:两牌都被压,遮挡者的伴都不可见 → 全留在剩余。
  //   launcher = t(闭包 1),target = l(闭包 1),并列取 tileId 小者
  //   挖 launcher:拿 f(1)→ 拿 t(2);挖 target:拿 g(3)→ 拿 l(4)→ 消 t+l
  const t5 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 9, 10, 0), mkS(2, 'f', 0, 10, 1),
    mkS(3, 'g', 9, 10, 1)]);
  check('T5 dig:挖 launcher(拿 f 1 → 拿 t 2)→ 挖 target(拿 g 3 → 拿 l 4)→ 消;峰值 4;f、g 留剩余',
    t5.type === 'dig' && seq(t5) === '1,2,3,4' && t5.matchCost === 4
      && t5.cost.residual.join(',') === '2,3' && t5.cost.steps === 4,
    `occ=${seq(t5)} peak=${t5.matchCost} res=${t5.cost.residual.join(',')}`);

  // T5b 回归:挖 target 时不得顺手拿 launcher 的遮挡者;launcher 自己被压时须先挖开
  //   launcher L 被 a 压、target T 被 b 压;a 的伴可点(清槽阶段能走),b 的伴不可见
  {
    const o = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 30, 10, 0), mkS(2, 'a', 0, 10, 1),
      mkS(3, 'b', 30, 10, 1), mkS(4, 'a', 40, 10, 0)]);
    check('T5b 先挖 launcher 再挖 target:拿 a(1)→ 拿 L(2)→ 拿 b(3)→ 拿 T(4)→ 消 → 清槽拿 a 伴(3)→ 消;峰值 4',
      seq(o) === '1,2,3,4,3' && o.matchCost === 4 && o.cost.residual.join(',') === '3' && o.cost.steps === 5,
      `occ=${seq(o)} peak=${o.matchCost} res=${o.cost.residual.join(',')}`);
  }

  // T6 共同路径:顶层牌同压两张配对牌 → 共享前置只占 1 格
  const t6 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', -14, 10, 0), mkS(2, 'z', -7, 2, 1)]);
  check('T6 共同路径:拿 top(1)→ 两张配对牌双亮,拿一张(2)→ 消;峰值 2',
    t6.cost.region.join(',') === '2' && seq(t6) === '1,2' && t6.matchCost === 2
      && t6.cost.residual.length === 0,
    `region=${t6.cost.region.join(',')} occ=${seq(t6)} peak=${t6.matchCost}`);

  // T7 内部对:两张同元素遮挡者同压 target → 它们自己配掉,但入槽时实打实占位
  const t7 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 30, 10, 0), mkS(2, 'f', -7, 4, 1),
    mkS(3, 'f', -7, 14, 1)]);
  check('T7 内部对:l(1)→ p(2)→ t(3)→ 消 l+t → q(2)→ 消 p+q;峰值 3(旧公式剔除后记 2)',
    seq(t7) === '1,2,3,2' && t7.matchCost === 3 && t7.cost.residual.length === 0,
    `occ=${seq(t7)} peak=${t7.matchCost} res=${t7.cost.residual.join(',')}`);

  // T8 候选规则的推论:中间那张被选为 target(设计者确认的行为)
  //   l 可点;c(第三张 e)压着 t 且自身被 top 压。闭包 c=1 < t=2 → 候选序 l < c < t
  {
    const A = an([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 30, 10, 0), mkS(2, 'e', 0, 10, 1),
      mkS(3, 'z', 0, 10, 2)]);
    const t8 = A.matches.opportunities.find(o => o.elementId === 'e');
    check('T8 中间那张被选为 target:launcher l / target c(c 压着 t ⇒ 闭包(c) < 闭包(t))',
      t8.launcher.tileId === 1 && t8.target.tileId === 2
        && (A.closureSize.get(2) ?? 0) < (A.closureSize.get(0) ?? 0),
      `launch=${t8.launcher.tileId} target=${t8.target.tileId}`);
    check('T8 消耗:拿 l(1)→ 挖 top(2)→ 拿 c(3)→ 消 l+c → top 出不去;峰值 3',
      seq(t8) === '1,2,3' && t8.matchCost === 3 && t8.cost.residual.join(',') === '3',
      `occ=${seq(t8)} peak=${t8.matchCost} res=${t8.cost.residual.join(',')}`);
  }

  // T9 未识别牌入槽:身份未知 → 永不配对 → 留在剩余
  {
    const q = { ...mkS(3, 'f', 18, 10, 0), elementId: '?' };
    const t9 = opOf([mkS(0, 'e', 0, 10, 0), mkS(1, 'e', 9, 10, 0), mkS(2, 'f', 0, 10, 1), q]);
    check('T9 未识别牌:不参与配对(p 无已知伴)→ p 留在剩余;峰值 3',
      t9.cost.residual.join(',') === '2' && t9.matchCost === 3,
      `occ=${seq(t9)} peak=${t9.matchCost} res=${t9.cost.residual.join(',')}`);
  }

  // T10 executable 由 peak 与空槽数直接比较得出
  check('T10 可执行性 = 峰值 ≤ 空槽数(T1 峰值 2 ≤ 空槽 4 → 可执行)',
    t1.executable === true && t1.matchCost <= 4);
}

{
  // 平铺盘:真实 Board 走一遍,验证随槽位变化峰值不变、可执行性随之变化
  const els = ['E1', 'E2', 'E3', 'E4'].map(e => ({ elementId: e, displayName: e, color: '#fff' }));
  const seq = ['E1', 'E1', 'E2', 'E2', 'E3', 'E3', 'E4', 'E4'];
  const tiles = seq.map((e, i) => ({ elementId: e, variant: 'FULL', gx: i * 8, gy: 2, layer: 0 }));
  const flat = new Board({ board: { w: 64 + 8, h: 14 }, elements: els, tiles });
  const step = (board) => analyze(perceive(board)).matches;

  let r = step(flat);
  check('平铺开局:4 个 double,峰值均为 2,可执行',
    r.byType.double === 4 && r.opportunities.every(o => o.matchCost === 2 && o.executable)
    && r.emptySlots === 4);

  flat.pick(0);   // E1a 入槽
  r = step(flat);
  const e1 = r.opportunities.find(o => o.elementId === 'E1');
  check('槽内持 E1a 后:E1 转 close,峰值 1(原有 1 张不计)',
    e1.type === 'close' && e1.cost.preexisting.length === 1 && e1.matchCost === 1
      && e1.cost.occupancy.join(',') === '1');

  flat.pick(2);   // E2a
  flat.pick(4);   // E3a → 槽 3,空槽 1
  r = step(flat);
  const e4 = r.opportunities.find(o => o.elementId === 'E4');
  check('空槽 1:E4 双亮对峰值仍为 2(不因资源不足而变)→ 不可执行',
    e4.matchCost === 2 && e4.executable === false && r.emptySlots === 1);
  check('空槽 1:三个 close 峰值 1 → 可执行',
    r.opportunities.filter(o => o.type === 'close').length === 3
    && r.opportunities.filter(o => o.type === 'close').every(o => o.matchCost === 1 && o.executable));
}

{
  // 编辑器盘(seed 7):不变量
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  const r2 = result.matches;
  check('开局:槽空 → 无 close;5 张可点牌互不同型 → 无 double',
    r2.byType.close === 0 && r2.byType.double === 0);

  check('获取成本公式(v3):pile 候选 = 1 + 闭包大小;槽内 = 0',
    r2.opportunities.every(o => [o.launcher, o.target].every(
      m => m.inSlot ? m.acquireCost === 0 : m.acquireCost === 1 + m.revealCount)));
  check('启动牌成本 ≤ 目标牌',
    r2.opportunities.every(o => o.launcher.acquireCost <= o.target.acquireCost));

  // 独立 DFS 闭包(不经 makeClosureIndex)用于对账
  const dfs = (id) => {
    const s = new Set();
    const walk = x => (result.blockersOf.get(x) ?? []).forEach(b => { if (!s.has(b)) { s.add(b); walk(b); } });
    walk(id);
    return s;
  };
  check('挖掘区 = 闭包(launcher) ∪ 闭包(target)(独立 DFS 对账)',
    r2.opportunities.every(o => {
      const u = new Set([...dfs(o.launcher.tileId), ...dfs(o.target.tileId)]);
      return o.cost.region.length === u.size && o.cost.region.every(id => u.has(id));
    }));

  check('峰值 = 占用序列的最大值;占用序列单调读数与步数一致',
    r2.opportunities.every(o => o.matchCost === Math.max(...o.cost.occupancy)
      && o.cost.occupancy.length === o.cost.steps && o.cost.occupancy.length > 0));
  check('峰值 ≥ 1 且 ≤ 模拟拿牌数(净占用不可能超过入槽总数)',
    r2.opportunities.every(o => o.matchCost >= 1 && o.matchCost <= o.cost.steps));
  check('相邻读数之差 ∈ {−1, +1}:每次拿 1 张入槽(+1)后 0 或 1 次消除(−2)→ 净变化 +1 / −1',
    r2.opportunities.every(o => o.cost.occupancy.every((v, i) =>
      i === 0 || v - o.cost.occupancy[i - 1] === 1 || v - o.cost.occupancy[i - 1] === -1)));
  check('可执行性 = 峰值 ≤ 空槽数',
    r2.opportunities.every(o => o.executable === (o.matchCost <= r2.emptySlots)));
  check('排序:matchCost 升序',
    r2.opportunities.every((o, i) => i === 0 || r2.opportunities[i - 1].matchCost <= o.matchCost));

  // 剩余牌的不变量:都是感知牌;其伴(若已知)既不在槽内也不可点——否则清槽会拿走
  const clickableNow = new Set(view.perceived
    .filter(t => result.derived.get(t.tileId)?.clickable === true).map(t => t.tileId));
  const slotIds = new Set(view.slot.map(s => s.tileId));
  const elemOf = new Map(view.perceived.map(t => [t.tileId, t.elementId]));
  check('剩余牌:伴不可点且不在槽内(否则清槽阶段会拿走)',
    r2.opportunities.every(o => o.cost.residual.every(id => {
      const e = elemOf.get(id);
      if (e === undefined || e === UNKNOWN_ELEMENT) return true;
      return !view.perceived.some(p => p.tileId !== id && elemOf.get(p.tileId) === e
        && clickableNow.has(p.tileId))
        && !view.slot.some(s => s.elementId === e);
    })));
  check('剩余牌无同元素对(槽内留下的牌之间不能互配)',
    r2.opportunities.every(o => {
      const seen = new Set();
      for (const id of o.cost.residual) {
        const e = elemOf.get(id);
        if (e === UNKNOWN_ELEMENT) continue;
        if (seen.has(e)) return false;
        seen.add(e);
      }
      return true;
    }));
  check('原有槽内牌 = 当前槽内牌(开局为空)',
    r2.opportunities.every(o => o.cost.preexisting.length === view.slot.length));

  const cheapest = r2.opportunities[0];
  const peaks = r2.opportunities.map(o => o.matchCost);
  const exec = r2.opportunities.filter(o => o.executable).length;
  console.log(`    盘面开局:hold ${r2.byType.hold} · dig ${r2.byType.dig} · 空槽 ${r2.emptySlots}`
    + ` · 峰值 最小 ${Math.min(...peaks)} / 均值 ${(peaks.reduce((s, x) => s + x, 0) / peaks.length).toFixed(2)}`
    + ` / 最大 ${Math.max(...peaks)} · 可执行 ${exec}/${r2.opportunities.length}`
    + ` · 最廉 ${cheapest.elementId}(${cheapest.matchCost} 格)`);
}

// ============================================================================
// 结果层等价性回归(2026-11-24,消除模拟提速·方案甲)
// 规则层已证明「单张牌的被压判定」与全盘重算等价(见 occlusion-v3.test.js);
// 这里证明「整个模拟跑下来的结果」也没变:在真实对局的每一步,用下面按原文
// 保留的旧实现(每拿一张牌就全盘重算一次)重跑报告里的每一条匹配,
// 逐字段比较全部产出。
// ============================================================================

console.log('— 结果层等价性回归:新模拟 ⇔ 旧的逐步全盘重算 —');
{
  /** 旧版消除模拟:2026-11-24 之前 Analysis.ts 里的实现,逐字移植。
   *  作为参照保留,勿随主代码改动。 */
  function legacySimulateMatch(view, launcherId, targetId, region, closureOf) {
    const elemOf = new Map();
    for (const t of view.perceived) elemOf.set(t.tileId, t.elementId);
    for (const s of view.slot) elemOf.set(s.tileId, s.elementId);

    const removed = new Set();
    const slot = [];
    const preexisting = [];
    for (const s of view.slot) { slot.push(s.tileId); preexisting.push(s.tileId); }
    const base = slot.length;

    const occupancy = [];
    const residual = [];
    const picks = [];
    let peak = 0;
    let steps = 0;

    const clickableNow = () => {
      const hypo = view.perceived.filter(t => !removed.has(t.tileId));
      const derived = computeOcclusion(hypo);
      const ids = [];
      for (const t of hypo) {
        if (derived.get(t.tileId)?.clickable === true) ids.push(t.tileId);
      }
      return ids.sort((a, b) => a - b);
    };
    const settle = () => {
      let paired = true;
      while (paired) {
        paired = false;
        outer: for (let i = 0; i < slot.length; i++) {
          const e = elemOf.get(slot[i]);
          if (e === undefined || e === UNKNOWN_ELEMENT) continue;
          for (let j = i + 1; j < slot.length; j++) {
            if (elemOf.get(slot[j]) === e) {
              slot.splice(j, 1);
              slot.splice(i, 1);
              paired = true;
              break outer;
            }
          }
        }
      }
    };
    const onPile = (id) => !removed.has(id) && !slot.some(x => x === id);
    const take = (id) => {
      if (!onPile(id)) return;
      removed.add(id);
      picks.push(id);
      slot.push(id);
      const net = slot.length - base;
      occupancy.push(net);
      if (net > peak) peak = net;
      settle();
      steps++;
    };

    const regionSet = new Set(region);
    const digAndTake = (goal) => {
      const own = new Set(closureOf(goal));
      let guard = 0;
      while (!removed.has(goal) && guard++ < view.perceived.length + 4) {
        const click = clickableNow();
        if (click.some(id => id === goal)) { take(goal); return; }
        const cands = click.filter(id => own.has(id) && regionSet.has(id) && onPile(id));
        if (cands.length === 0) break;
        const slotElems = new Set(slot.map(id => elemOf.get(id)));
        const closing = cands.filter(id => slotElems.has(elemOf.get(id)));
        take((closing.length > 0 ? closing : cands)[0]);
      }
    };

    if (!preexisting.some(id => id === launcherId)) digAndTake(launcherId);
    digAndTake(targetId);

    let acted = true;
    let guard = 0;
    while (acted && guard++ < view.perceived.length + 4) {
      acted = false;
      const click = clickableNow();
      for (let i = 0; i < slot.length; i++) {
        const x = slot[i];
        const e = elemOf.get(x);
        if (e === undefined || e === UNKNOWN_ELEMENT) continue;
        const mate = click.find(id => onPile(id) && elemOf.get(id) === e);
        if (mate !== undefined) { take(mate); acted = true; break; }
      }
    }

    for (const id of slot) residual.push(id);
    return { peak, preexisting, occupancy, residual, steps, picks };
  }

  /** 闭包成员(与旧实现所用相同:沿 blockersOf 的传递闭包,tileId 升序) */
  const closureIndexOf = (analysis) => {
    const memo = new Map();
    return (id) => {
      const hit = memo.get(id);
      if (hit) return hit;
      const set = new Set();
      const walk = (x) => {
        for (const b of analysis.blockersOf.get(x) ?? []) {
          if (!set.has(b)) { set.add(b); walk(b); }
        }
      };
      walk(id);
      const arr = [...set].sort((a, b) => a - b);
      memo.set(id, arr);
      return arr;
    };
  };

  const mkEls = n => Array.from({ length: n }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: 'e', color: '#fff' }));
  const S = { steps: 0, entries: 0, simSteps: 0, withResidual: 0, launcherInSlot: 0, badSim: 0, firstBad: '',
    reveals: 0, badReveal: 0, minTiles: Infinity, maxTiles: 0 };
  // 用默认梯跑真实对局(覆盖开局到残局;7/14/35 元素各取数局)
  for (const [n, games] of [[7, 3], [14, 2], [35, 1]]) {
    for (let g = 0; g < games; g++) {
      const els = mkEls(n);
      const b = new Board({ board: LAYOUT.board, elements: els, tiles: fillSlots(LAYOUT.tiles, { elements: els, seed: 1000 + g }) });
      for (let step = 0; step < 300; step++) {
        if (b.isCleared()) break;
        const view = perceive(b);
        if (view.perceived.length === 0) break;
        const a = analyze(view);
        const click = view.perceived.filter(t => a.derived.get(t.tileId).clickable);
        if (click.length === 0) break;
        S.steps++; S.minTiles = Math.min(S.minTiles, view.perceived.length); S.maxTiles = Math.max(S.maxTiles, view.perceived.length);

        // ① 每条匹配:用旧模拟重跑,比较全部产出
        const closureOf = closureIndexOf(a);
        for (const o of a.matches.opportunities) {
          S.entries++; S.simSteps += o.cost.steps;
          if (o.cost.residual.length > 0) S.withResidual++;
          if (o.launcher.inSlot) S.launcherInSlot++;
          const ref = legacySimulateMatch(view, o.launcher.tileId, o.target.tileId, o.cost.region, closureOf);
          const same = ref.peak === o.matchCost
            && JSON.stringify(ref.preexisting) === JSON.stringify(o.cost.preexisting)
            && JSON.stringify(ref.occupancy) === JSON.stringify(o.cost.occupancy)
            && JSON.stringify(ref.residual) === JSON.stringify(o.cost.residual)
            && ref.steps === o.cost.steps
            && JSON.stringify(ref.picks) === JSON.stringify(o.cost.picks);
          if (!same) {
            S.badSim++;
            if (!S.firstBad) S.firstBad = `${o.elementId} ${o.type}: 峰值 ${ref.peak}/${o.matchCost} 占用 ${ref.occupancy}/${o.cost.occupancy} `
              + `剩余 ${ref.residual}/${o.cost.residual} 计划 ${ref.picks}/${o.cost.picks}`;
          }
        }

        // ② 揭示预演:拿走每张可点牌后「哪些直接目标变可点」——旧法在假设集合上全盘重算
        const picksToTest = click.length <= 4 ? click : [click[0], click[1], click[click.length - 2], click[click.length - 1]];
        for (const c of picksToTest) {
          S.reveals++;
          const hypo = view.perceived.filter(t => t.tileId !== c.tileId);
          const d = computeOcclusion(hypo);
          const expect = (a.occludesOf.get(c.tileId) ?? [])
            .filter(t => a.derived.get(t)?.clickable !== true && d.get(t)?.clickable === true)
            .sort((x, y) => x - y);
          const got = simulateReveal(c.tileId, view, a).clickable.map(x => x.tileId);
          if (JSON.stringify(expect) !== JSON.stringify(got)) S.badReveal++;
        }

        const op = decideByLadder(defaultLadder, { view, analysis: a, clickable: click, rng: lcg(2000 + g + step) });
        const r = b.pick(op.action.tileId); if (!r.ok) break;
        if (r.paired) { b.eliminate(r.paired[0], r.paired[1]); b.compactSlots(); }
        if (b.isSlotFull() && !b.findSlotPair()) break;
      }
    }
  }
  console.log(`    样本:${S.steps} 步(盘面 ${S.minTiles}~${S.maxTiles} 张)· 匹配条目 ${S.entries} 条、共 ${S.simSteps} 个模拟步`
    + `(其中结束时有遗留牌的 ${S.withResidual} 条、启动牌在槽内的 ${S.launcherInSlot} 条)· 揭示预演 ${S.reveals} 次`);
  check('消除模拟:新实现与旧的逐步全盘重算逐条目、逐字段一致(峰值/占用序列/剩余牌/步数/拿牌顺序)',
    S.badSim === 0, `${S.badSim} 条不一致;首例:${S.firstBad}`);
  check('样本量足够(≥ 200 步、≥ 1000 条匹配、覆盖残局)',
    S.steps >= 200 && S.entries >= 1000 && S.minTiles <= 10, JSON.stringify(S));
  check('揭示预演:拿走一张后变可点的直接目标,与在假设集合上全盘重算一致',
    S.badReveal === 0, `${S.badReveal}/${S.reveals} 次不一致`);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
