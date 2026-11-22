// ============================================================================
// agent-perception.test.js — 代理 ①感知/②分析 回归测试(node 直跑,不依赖 cc)
//
// 统一测试盘面:编辑器当前布局 assets/data/layouts/test_layout.json
// + 随机填充 seed 7(与 LayoutPreview 预览完全一致)
//
// 编译(纯逻辑文件,无 cc 依赖):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/agent-perception.test.js
// ============================================================================

const LAYOUT = require('../assets/data/layouts/test_layout.json');
const { Board } = require('../temp/v3check/core/Board');
const { computeDepths } = require('../temp/v3check/core/Depth');
const { coversAny } = require('../temp/v3check/core/Occlusion');
const { fillSlots } = require('../temp/v3check/core/RandomFill');
const { buildMahjongElements } = require('../temp/v3check/core/MahjongSet');
const { perceive, UNKNOWN_ELEMENT } = require('../temp/v3check/agent/Perception');
const { analyze, groupByIdentity, revealUtility, matchOpportunities } = require('../temp/v3check/agent/Analysis');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
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
  const realDerived = new Map(board.allTiles().map(t => [t.tileId, board.getDerived(t.tileId)]));
  const result = analyze(view, realDerived);

  const perIds = new Set(view.perceived.map(t => t.tileId));
  check('遮挡边全部落在感知子集内',
    result.edges.every(e => perIds.has(e.above) && perIds.has(e.below)));

  const realEdges = new Set();
  const all = board.allTiles();
  for (const a of all) for (const b of all) {
    if (a.tileId !== b.tileId && coversAny(a, b)) realEdges.add(a.tileId + '->' + b.tileId);
  }
  check(`感知边 ⊆ 真实边(感知 ${result.edges.length} / 真实 ${realEdges.size})`,
    result.edges.every(e => realEdges.has(e.above + '->' + e.below)));

  const realDepth = computeDepths(all);
  check('代理深度 ≤ 真实深度(感知子图的下界)',
    view.perceived.every(t =>
      (result.depth.depth.get(t.tileId) ?? 0) <= (realDepth.depth.get(t.tileId) ?? 0)));

  check('v3 等价定理:主观可点性与真值零冲突', result.clickConflicts.length === 0,
    `conflicts: ${result.clickConflicts.join(',')}`);
  const subjectiveClickable = view.perceived.filter(t => result.derived.get(t.tileId).clickable).length;
  const realClickable = board.clickableTiles().length;
  check(`主观可点数 = 真实可点数(${subjectiveClickable})`, subjectiveClickable === realClickable);
  check('blockersOf 与边集一致',
    result.edges.every(e => (result.blockersOf.get(e.below) || []).includes(e.above)));
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

  const realDerived = new Map(board.allTiles().map(t => [t.tileId, board.getDerived(t.tileId)]));
  const r2 = analyze(v2, realDerived);
  check('拾取后可点性仍零冲突', r2.clickConflicts.length === 0);
}

console.log('— 分析扩展:同类归组 —');
{
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  const report = groupByIdentity(view, result);

  const pileSum = [...report.groups.values()].reduce((s, g) => s + g.pile.length, 0);
  check('守恒:Σ分组pile + 未识别 = 感知数',
    pileSum + report.unknownPileCount === view.perceived.length,
    `${pileSum}+${report.unknownPileCount} vs ${view.perceived.length}`);
  check('识别数口径一致',
    report.identifiedPileCount === view.perceived.length - report.unknownPileCount);

  check('分组键 = 真实 elementId(识别牌无错归)',
    [...report.groups.values()].every(g =>
      g.pile.every(r => board.getTile(r.tileId).elementId === g.elementId)));

  check('记录深度/可点性与结构分析一致',
    [...report.groups.values()].every(g =>
      g.pile.every(r =>
        r.depth === (result.depth.depth.get(r.tileId) ?? 0) &&
        r.clickable === (result.derived.get(r.tileId)?.clickable === true))));

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
  const report2 = groupByIdentity(view2, result2);
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
  const util = revealUtility(view, result);

  check('occludesOf 与边集对偶(每条边 above→below 各计一次)',
    result.edges.every(e => result.occludesOf.get(e.above).includes(e.below))
    && result.edges.every(e => result.blockersOf.get(e.below).includes(e.above)));

  // 独占 ⊆ 投影相交(结构关系)
  const occludes = new Map();
  result.edges.forEach(e => {
    if (!occludes.has(e.above)) occludes.set(e.above, new Set());
    occludes.get(e.above).add(e.below);
  });
  check('独占直接遮挡 ⊆ 投影遮挡关系',
    [...util.direct.entries()].every(([id, ts]) =>
      ts.every(t => occludes.get(id)?.has(t))));

  // 顶层唯一效能王:L5 五万,独占 4(压着 L4 缝上四张;纯几何,与填充无关)
  const topLayer = Math.max(...LAYOUT.tiles.map(t => t.layer));
  const maxHolders = view.perceived.filter(t => util.count.get(t.tileId) === util.max);
  check(`顶层效能王:唯一最大 ${util.max} 张,且在 L${topLayer}`,
    util.max === 4 && maxHolders.length === 1 && maxHolders[0].layer === topLayer,
    `max=${util.max} holders=${maxHolders.length}`);
  const king = board.getTile(maxHolders[0].tileId);
  const kingTargets = util.direct.get(maxHolders[0].tileId).map(id => board.getTile(id).elementId).sort();
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

  // 拾取效能王(顶层可点)后重算正常
  board.pick(maxHolders[0].tileId);
  const view2 = perceive(board);
  const result2 = analyze(view2);
  const util2 = revealUtility(view2, result2);
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

console.log('— 分析扩展:匹配消耗(启动牌 × 目标牌,v2.1 闭包口径)—');
{
  // 平铺小盘:4 元素 × 1 对,全部可点(成本与冻结语义精确验证)
  const els = ['E1', 'E2', 'E3', 'E4'].map(e => ({ elementId: e, displayName: e, color: '#fff' }));
  const seq = ['E1', 'E1', 'E2', 'E2', 'E3', 'E3', 'E4', 'E4'];
  const tiles = seq.map((e, i) => ({ elementId: e, variant: 'FULL', gx: i * 8, gy: 2, layer: 0 }));
  const flat = new Board({ board: { w: 64 + 8, h: 14 }, elements: els, tiles });

  const step = (board) => {
    const v = perceive(board);
    return matchOpportunities(v, analyze(v));
  };

  let r = step(flat);
  check('开局:4 个 double,matchCost = 1+1 = 2,可执行',
    r.byType.double === 4 && r.opportunities.every(
      o => o.type === 'double' && o.matchCost === 2 && o.executable)
    && r.emptySlots === 4);

  flat.pick(0);   // E1a 入槽 → 成本 0 的启动牌
  r = step(flat);
  const e1 = r.opportunities.find(o => o.elementId === 'E1');
  check('槽内牌成为启动牌(成本 0):E1 = close,matchCost 1',
    e1.launcher.inSlot && e1.launcher.acquireCost === 0
    && e1.target.acquireCost === 1 && e1.matchCost === 1 && e1.type === 'close');

  flat.pick(2);   // E2a
  flat.pick(4);   // E3a → 槽 3,空槽 1
  r = step(flat);
  const e4 = r.opportunities.find(o => o.elementId === 'E4');
  check('资源不足仍计算:E4 double matchCost = 2 但不可执行(空槽 1 < 2)',
    e4.matchCost === 2 && e4.executable === false && r.emptySlots === 1);
  check('槽内 3 张:close 全部可执行(空槽 1 ≥ 1)',
    r.byType.close === 3
    && r.opportunities.filter(o => o.type === 'close').every(o => o.executable));

  const pk = flat.pick(1);   // E1b 闭对
  check('闭对拾取实际触发配对', !!pk.paired);
  flat.eliminate(pk.paired[0], pk.paired[1]); flat.compactSlots();

  // 编辑器盘面(seed 7):hold / dig 的消耗公式与排序
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  const r2 = matchOpportunities(view, result);
  check('开局:槽空 → 无 close;5 张可点牌互不同型 → 无 double',
    r2.byType.close === 0 && r2.byType.double === 0);

  check('获取成本公式:pile 候选 = 1 + (闭包 + 深度)/2(v2.2 双口径平均)',
    r2.opportunities.every(o => [o.launcher, o.target].every(
      m => m.inSlot ? m.acquireCost === 0
        : m.acquireCost === 1 + (m.revealCount + m.revealDepth) / 2)));
  check('启动牌成本 ≤ 目标牌',
    r2.opportunities.every(o => o.launcher.acquireCost <= o.target.acquireCost));
  check('hold 型:目标被压(闭包 ≥1),启动牌可点',
    r2.opportunities.filter(o => o.type === 'hold').length > 0
    && r2.opportunities.filter(o => o.type === 'hold').every(
      o => o.target.revealCount >= 1 && !o.launcher.inSlot && o.launcher.revealCount === 0));
  check('dig 型:双埋(两口径均 ≥1),matchCost = 2 + 两均值之和 ≥ 4',
    r2.opportunities.filter(o => o.type === 'dig').length > 0
    && r2.opportunities.filter(o => o.type === 'dig').every(
      o => o.launcher.revealCount >= 1 && o.launcher.revealDepth >= 1
        && o.target.revealCount >= 1 && o.target.revealDepth >= 1
        && o.matchCost === 2
          + (o.launcher.revealCount + o.launcher.revealDepth) / 2
          + (o.target.revealCount + o.target.revealDepth) / 2
        && o.matchCost >= 4));
  check('双口径与结构分析一致(目标牌:闭包对 closureSize,深度对 depth)',
    r2.opportunities.every(o => !o.target.inSlot
      && (result.closureSize.get(o.target.tileId) ?? 0) === o.target.revealCount
      && (result.depth.depth.get(o.target.tileId) ?? 0) === o.target.revealDepth
      && (result.derived.get(o.target.tileId)?.clickable === true
        ? o.target.revealCount === 0 && o.target.revealDepth === 0 : true)));
  check('排序:matchCost 升序',
    r2.opportunities.every((o, i) => i === 0 || r2.opportunities[i - 1].matchCost <= o.matchCost));

  const cheapest = r2.opportunities[0];
  const digs = r2.opportunities.filter(o => o.type === 'dig');
  const digAvg = digs.length ? (digs.reduce((s, o) => s + o.matchCost, 0) / digs.length).toFixed(2) : '-';
  console.log(`    盘面开局:hold ${r2.byType.hold} · dig ${r2.byType.dig} · 空槽 ${r2.emptySlots}`
    + ` · 最廉匹配 ${cheapest.elementId}(成本 ${cheapest.matchCost}) · dig 均值 ${digAvg}`
    + `(闭包口径)`);
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
