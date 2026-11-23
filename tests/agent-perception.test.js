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
const { analyze } = require('../temp/v3check/agent/Analysis');

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

  const conflicts = clickConflicts(board, view, result);
  check('v3 等价定理:主观可点性与真值零冲突', conflicts.length === 0,
    `conflicts: ${conflicts.join(',')}`);
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
  const util = result.reveal;

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
  const sr = analyze(sv);
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
  const util2 = result2.reveal;
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

console.log('— 分析扩展:伴成本 mateCost(v2.3 配对负担加权 · 分步第一步)—');
{
  // A. Board 集成:平铺全易盘 → 伴成本恒 1;入槽后伴成本 0
  const els = ['E1', 'E2', 'E3', 'E4'].map(e => ({ elementId: e, displayName: e, color: '#fff' }));
  const seq = ['E1', 'E1', 'E2', 'E2', 'E3', 'E3', 'E4', 'E4'];
  const tiles = seq.map((e, i) => ({ elementId: e, variant: 'FULL', gx: i * 8, gy: 2, layer: 0 }));
  const flatBoard = new Board({ board: { w: 64 + 8, h: 14 }, elements: els, tiles });

  let v = perceive(flatBoard);
  let r = analyze(v);
  let mc = r.mate;
  check('全易盘:伴成本 = 1(伴可点),环境物价 = 1',
    mc.ambient === 1 && v.perceived.every(t => mc.cost.get(t.tileId) === 1));
  check('mateOf 指向同元素伴且非自身',
    v.perceived.every(t => {
      const mate = mc.mateOf.get(t.tileId);
      return mate !== null && mate !== t.tileId
        && flatBoard.getTile(mate).elementId === t.elementId;
    }));

  flatBoard.pick(0);   // E1a 入槽(成本 0 的伴)
  v = perceive(flatBoard);
  r = analyze(v);
  mc = r.mate;
  check('槽内伴:E1b 伴成本 = 0(配对半价已预付),mateOf = 槽内牌',
    mc.cost.get(1) === 0 && mc.mateOf.get(1) === 0,
    `cost=${mc.cost.get(1)} mateOf=${mc.mateOf.get(1)}`);
  check('环境物价不含槽内牌(仍 = 1)', mc.ambient === 1);
  check('其余元素不受槽影响(伴成本仍 1)',
    [2, 3, 4, 5, 6, 7].every(id => mc.cost.get(id) === 1));
  check('伴去向:全易盘无闭包 → 无记录、四类全 0',
    mc.closureMates.length === 0
    && v.perceived.every(t => ['ready', 'contained', 'external', 'unknown']
      .every(k => mc.dispositionCount.get(t.tileId)[k] === 0)));
}
{
  // B. 解析合成盘:D 压 X;D 的伴 m 被两张浅牌盖(闭包 2/深度 1 → flat 2.5)
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const X = mkS(0, 'x', 0, 10, 0);
  const D = mkS(1, 'd', 0, 10, 1);     // 全压 X
  const m = mkS(2, 'd', 20, 10, 0);    // D 的伴,埋着
  const M1 = mkS(3, 'm1', 16, 10, 1);  // 盖 m 左半 [20,24]
  const M2 = mkS(4, 'm2', 26, 10, 1);  // 盖 m 右带 [26,28](留 [24,26] 暴露)
  const Q = mkS(5, '?', 40, 10, 0);    // 未识别
  const sv = { perceived: [X, D, m, M1, M2, Q], slot: [], exposure: new Map(), totalPileCount: 6 };
  const mc = analyze(sv).mate;

  check('埋藏计价(单跳 flat,m 闭包 2/深度 1):D 的伴成本 = flat(m) = 2.5',
    mc.cost.get(1) === 2.5 && mc.mateOf.get(1) === 2,
    `cost=${mc.cost.get(1)} mateOf=${mc.mateOf.get(1)}`);
  check('对称:D 可点 flat 1 = m 的伴成本', mc.cost.get(2) === 1 && mc.mateOf.get(2) === 1);
  check('无已知伴回落环境物价:X(独元素)与 ? 牌 = 1.5 = ambient(flat:X2/D1/m2.5/M1 1/M2 1 → 7.5/5)',
    Math.abs(mc.ambient - 1.5) < 1e-9
    && Math.abs(mc.cost.get(0) - 1.5) < 1e-9 && mc.mateOf.get(0) === null
    && Math.abs(mc.cost.get(5) - 1.5) < 1e-9 && mc.mateOf.get(5) === null,
    `ambient=${mc.ambient} X=${mc.cost.get(0)} Q=${mc.cost.get(5)}`);
  check('覆盖:全部感知牌均有账(含 ? 牌)', mc.cost.size === 6 && mc.mateOf.size === 6);
}
{
  // C. 多候选取最廉 + 并列 tileId 小者:元素 e 三张,expensive 埋 1 层
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const b = mkS(0, 'e', 0, 10, 0);
  const cheap = mkS(1, 'e', 10, 10, 0);
  const expensive = mkS(2, 'e', 20, 10, 0);
  const Bx = mkS(3, 'z', 20, 10, 1);
  const sv = { perceived: [b, cheap, expensive, Bx], slot: [], exposure: new Map(), totalPileCount: 4 };
  const mc = analyze(sv).mate;
  check('多候选取最廉:b 的伴 = cheap(flat 1),非 expensive(flat 2)',
    mc.cost.get(0) === 1 && mc.mateOf.get(0) === 1);
  check('并列取 tileId 小者:expensive 的伴在 b/cheap(均 1)间取 b',
    mc.cost.get(2) === 1 && mc.mateOf.get(2) === 0);
  check('独元素遮挡者 Bx 走环境物价(flat 1/1/2/1 → 5/4 = 1.25)',
    Math.abs(mc.cost.get(3) - 1.25) < 1e-9 && mc.mateOf.get(3) === null,
    `cost=${mc.cost.get(3)}`);
}
{
  // D. 单跳口径(v1 回退):不追问遮挡者的伴——P1 埋多深只看 flat
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const P0 = mkS(0, 'e0', 0, 10, 0);
  const P1 = mkS(1, 'e0', 10, 10, 0);   const Q1 = mkS(2, 'e1', 10, 10, 1);
  const P2 = mkS(3, 'e1', 20, 10, 0);   const Q2 = mkS(4, 'e2', 20, 10, 1);
  const P3 = mkS(5, 'e2', 30, 10, 0);   const Q3 = mkS(6, 'e3', 30, 10, 1);
  const P4 = mkS(7, 'e3', 40, 10, 0);   // 槽内(e3 的现成伴,成本 0)
  P4.status = 'slot'; P4.slotIndex = 0;
  const sv = { perceived: [P0, P1, Q1, P2, Q2, P3, Q3], slot: [P4], exposure: new Map(), totalPileCount: 8 };
  const mc = analyze(sv).mate;
  check('单跳定价(v1):cost(P0) = flat(P1) = 2,不追问 P1 遮挡者的伴在哪',
    mc.cost.get(0) === 2 && mc.mateOf.get(0) === 1,
    `cost=${mc.cost.get(0)}`);
  check('槽内伴:Q3 成本 0', mc.cost.get(6) === 0 && mc.mateOf.get(6) === 7);
}
{
  // E. 单跳口径:同元素互埋对(回环概念随递归移除,此盘验互选语义)
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const P = mkS(0, 'e', 0, 10, 0);
  const Bx = mkS(1, 'e', 0, 10, 1);
  const sv = { perceived: [P, Bx], slot: [], exposure: new Map(), totalPileCount: 2 };
  const mc = analyze(sv).mate;
  check('单跳定价(v1):cost(Bx) = flat(P) = 2(P 埋 1 层),mateOf = P',
    mc.cost.get(1) === 2 && mc.mateOf.get(1) === 0);
  check('被压方视角:cost(P) = 1(Bx 可点 flat 1)',
    mc.cost.get(0) === 1 && mc.mateOf.get(0) === 1);
}

console.log('— 分析扩展:伴去向分类(闭包相对;配对数据的扩展)—');
{
  // F1. 混合盘:T 被同层骑缝的 b1、a2 压,a2 上再压 c
  //     b1 的伴 a2 埋在本闭包内 → contained;a2 的伴 b1 可点 → ready;c 独元素 → unknown
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const T = mkS(0, 't', 0, 10, 0);
  const b1 = mkS(1, 'a', -6, 10, 1);   // 盖 T 左带 [0,2](25% > 18%)
  const a2 = mkS(2, 'a', 3, 10, 1);    // 盖 T 右带 [3,8](50%)
  const c = mkS(3, 'c', 3, 10, 2);     // 全压 a2
  const sv = { perceived: [T, b1, a2, c], slot: [], exposure: new Map(), totalPileCount: 4 };
  const mc = analyze(sv).mate;
  const rec = (target, blocker) =>
    mc.closureMates.find(r => r.target === target && r.blocker === blocker);
  const cnt = mc.dispositionCount.get(0);
  const KEYS = ['ready', 'contained', 'external', 'unknown'];
  const zeros = (id) => KEYS.every(k => mc.dispositionCount.get(id)[k] === 0);
  check('F1 记录齐全:T 闭包 {b1,a2,c} 三条 + a2 闭包 {c} 一条(c → unknown);b1/c 闭包为空',
    mc.closureMates.length === 4 && [1, 2, 3].every(id => !!rec(0, id))
    && !!rec(2, 3) && rec(2, 3).disposition === 'unknown' && rec(2, 3).mateId === null
    && mc.dispositionCount.size === 4 && zeros(1) && zeros(3)
    && !zeros(0) && !zeros(2));
  check('F1 contained:b1 的伴 a2 埋在本闭包内(flat 2)',
    rec(0, 1).disposition === 'contained' && rec(0, 1).mateId === 2 && rec(0, 1).mateFlat === 2);
  check('F1 ready:a2 的伴 b1 可点(flat 1)',
    rec(0, 2).disposition === 'ready' && rec(0, 2).mateId === 1 && rec(0, 2).mateFlat === 1);
  check('F1 unknown:c 无已知伴(mateId null,flat = ambient 1.875)',
    rec(0, 3).disposition === 'unknown' && rec(0, 3).mateId === null
    && Math.abs(rec(0, 3).mateFlat - 1.875) < 1e-9,
    `mateFlat=${rec(0, 3).mateFlat}`);
  check('F1 四类计数:ready 1 / contained 1 / external 0 / unknown 1(和 = closureSize 3)',
    cnt.ready === 1 && cnt.contained === 1 && cnt.external === 0 && cnt.unknown === 1
    && analyze(sv).closureSize.get(0) === 3);
}
{
  // F2. 伴即被挖牌本身:同元素互压对 → contained(配对在挖掘区内闭合)
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const P = mkS(0, 'e', 0, 10, 0);
  const Bx = mkS(1, 'e', 0, 10, 1);
  const sv = { perceived: [P, Bx], slot: [], exposure: new Map(), totalPileCount: 2 };
  const mc = analyze(sv).mate;
  const r = mc.closureMates[0];
  check('F2 伴 = target 本身 → contained(Bx 的伴是它压着的 P,flat 2)',
    mc.closureMates.length === 1 && r.target === 0 && r.blocker === 1
    && r.disposition === 'contained' && r.mateId === 0 && r.mateFlat === 2);
}
{
  // F3. external(伴埋在闭包外)+ 槽内伴 ready:e0→e1→e2 伴链
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const P0 = mkS(0, 'e0', 0, 10, 0);
  const P1 = mkS(1, 'e0', 10, 10, 0);   const Q1 = mkS(2, 'e1', 10, 10, 1);
  const P2 = mkS(3, 'e1', 20, 10, 0);   const Q2 = mkS(4, 'e2', 20, 10, 1);
  const P3 = mkS(5, 'e2', 30, 10, 0);   const Q3 = mkS(6, 'e3', 30, 10, 1);
  const P4 = mkS(7, 'e3', 40, 10, 0);
  P4.status = 'slot'; P4.slotIndex = 0;
  const sv = { perceived: [P0, P1, Q1, P2, Q2, P3, Q3], slot: [P4], exposure: new Map(), totalPileCount: 8 };
  const mc = analyze(sv).mate;
  const rec = (target, blocker) =>
    mc.closureMates.find(r => r.target === target && r.blocker === blocker);
  check('F3 external:P1 的遮挡者 Q1,其伴 P2 埋在闭包外(flat 2)',
    rec(1, 2).disposition === 'external' && rec(1, 2).mateId === 3 && rec(1, 2).mateFlat === 2);
  check('F3 external 链:P2 的遮挡者 Q2,其伴 P3 埋在闭包外',
    rec(3, 4).disposition === 'external' && rec(3, 4).mateId === 5);
  check('F3 ready(槽内):P3 的遮挡者 Q3,其伴 P4 在槽内(flat 0)',
    rec(5, 6).disposition === 'ready' && rec(5, 6).mateId === 7 && rec(5, 6).mateFlat === 0);
  check('F3 记录总数 3(闭包 {Q1} / {Q2} / {Q3})', mc.closureMates.length === 3);
}
{
  // F4. 优先级:闭包内的双亮对(两遮挡者互为伴且均可点)→ ready,而非 contained
  const mkS = (tileId, elementId, gx, gy, layer) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
  const T = mkS(0, 't', 0, 10, 0);
  const p = mkS(1, 'p', -6, 10, 1);
  const q = mkS(2, 'p', 3, 10, 1);
  const sv = { perceived: [T, p, q], slot: [], exposure: new Map(), totalPileCount: 3 };
  const mc = analyze(sv).mate;
  const rec = (blocker) => mc.closureMates.find(r => r.target === 0 && r.blocker === blocker);
  const cnt = mc.dispositionCount.get(0);
  check('F4 双亮对在闭包内 → 双 ready(ready 优先于 contained)',
    rec(1).disposition === 'ready' && rec(1).mateId === 2
    && rec(2).disposition === 'ready' && rec(2).mateId === 1
    && cnt.ready === 2 && cnt.contained === 0);
}
{
  // F5. 编辑器盘:不变量对账(四类之和 vs closureSize 走 OcclusionTopology 独立路径)
  const board = buildEditorBoard();
  const view = perceive(board);
  const result = analyze(view);
  const mc = result.mate;
  const KEYS = ['ready', 'contained', 'external', 'unknown'];
  const sum = (id) => KEYS.reduce((s, k) => s + mc.dispositionCount.get(id)[k], 0);
  check('每张感知牌四类之和 = closureSize(独立口径对账)',
    view.perceived.every(t => sum(t.tileId) === (result.closureSize.get(t.tileId) ?? 0)));
  check('记录数 = Σ 闭包大小',
    mc.closureMates.length === view.perceived.reduce((s, t) => s + sum(t.tileId), 0));
  check('记录与配对数据一致(mateId = mateOf, mateFlat = cost)',
    mc.closureMates.every(r =>
      r.mateId === mc.mateOf.get(r.blocker) && r.mateFlat === mc.cost.get(r.blocker)));
  const order = view.perceived.map(t => t.tileId);
  check('记录顺序确定(target 按 perceived 序,blocker 升序)',
    mc.closureMates.every((r, i) => {
      if (i === 0) return true;
      const p = mc.closureMates[i - 1];
      return order.indexOf(r.target) > order.indexOf(p.target)
        || (r.target === p.target && r.blocker > p.blocker);
    }));
  const total = KEYS.map(k => view.perceived.reduce((s, t) => s + mc.dispositionCount.get(t.tileId)[k], 0));
  console.log(`    全盘闭包成员 ${mc.closureMates.length} 条:`
    + KEYS.map((k, i) => `${k} ${total[i]}`).join(' · '));
  const fmt = (id) => {
    const c = mc.dispositionCount.get(id);
    return `就绪${c.ready}/自含${c.contained}/外联${c.external}/未知${c.unknown}`;
  };
  result.matches.opportunities
    .filter(o => o.type === 'dig').sort((a, b) => a.matchCost - b.matchCost)
    .forEach(o => console.log(`    dig ${o.elementId.padEnd(6)} v2.2 ${String(o.matchCost).padStart(5)}`
      + ` · 启动牌闭包 ${fmt(o.launcher.tileId)} · 目标牌闭包 ${fmt(o.target.tileId)}`));
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
    return analyze(v).matches;
  };

  let r = step(flat);
  check('开局:4 个 double,matchCost = 1+1 = 2,可执行',
    r.byType.double === 4 && r.opportunities.every(
      o => o.type === 'double' && o.matchCost === 2 && o.executable)
    && r.emptySlots === 4);
  check('v2.3 另档(退化):全易盘 acquireCostR = acquireCost,matchCostR = matchCost',
    r.opportunities.every(o => o.matchCostR === o.matchCost
      && [o.launcher, o.target].every(m => m.acquireCostR === m.acquireCost)));

  flat.pick(0);   // E1a 入槽 → 成本 0 的启动牌
  r = step(flat);
  const e1 = r.opportunities.find(o => o.elementId === 'E1');
  check('槽内牌成为启动牌(成本 0):E1 = close,matchCost 1',
    e1.launcher.inSlot && e1.launcher.acquireCost === 0
      && e1.target.acquireCost === 1 && e1.matchCost === 1 && e1.type === 'close');
  check('槽内启动牌两档同 0(v2.3 acquireCostR)',
    e1.launcher.acquireCostR === 0);

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
  const r2 = result.matches;
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
  check('v2.3 另档:matchCostR = 两牌 acquireCostR 之和',
    r2.opportunities.every(o =>
      o.matchCostR === o.launcher.acquireCostR + o.target.acquireCostR));
  check('开局无槽 → 无折扣通道:acquireCostR ≥ acquireCost(unit ≥ 1 且闭包 ≥ 均值)',
    r2.opportunities.every(o =>
      [o.launcher, o.target].every(m => m.acquireCostR >= m.acquireCost)));

  const cheapest = r2.opportunities[0];
  const digs = r2.opportunities.filter(o => o.type === 'dig');
  const digAvg = digs.length ? (digs.reduce((s, o) => s + o.matchCost, 0) / digs.length).toFixed(2) : '-';
  console.log(`    盘面开局:hold ${r2.byType.hold} · dig ${r2.byType.dig} · 空槽 ${r2.emptySlots}`
    + ` · 最廉匹配 ${cheapest.elementId}(成本 ${cheapest.matchCost}) · dig 均值 ${digAvg}`
    + `(闭包口径)`);
  const digAvgR = digs.length ? (digs.reduce((s, o) => s + o.matchCostR, 0) / digs.length).toFixed(2) : '-';
  console.log(`    v2.3 另档:dig 均值 ${digAvgR} · 最廉 ${[...r2.opportunities]
    .sort((a, b) => a.matchCostR - b.matchCostR)[0].elementId}`
    + `(costR ${[...r2.opportunities].sort((a, b) => a.matchCostR - b.matchCostR)[0].matchCostR.toFixed(2)})`);

  // 回归:获取查询不得被自指种子切断——v2.3 必须真正递归出分化
  {
    const mkM = (tileId, elementId, gx, gy, layer) =>
      ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });
    const t = mkM(0, 'e', 0, 10, 0);     // 埋 1 层(target)
    const t2 = mkM(1, 'e', 10, 10, 0);   // 可点(launcher)
    const b = mkM(2, 'f', 0, 10, 1);     // 压 t;b 的伴 m 也埋着
    const m = mkM(3, 'f', 20, 10, 0);
    const q = mkM(4, 'g', 20, 10, 1);    // 压 m;q 的伴 g2 可点
    const g2 = mkM(5, 'g', 30, 10, 0);
    const sv = { perceived: [t, t2, b, m, q, g2], slot: [], exposure: new Map(), totalPileCount: 6 };
    const rr = analyze(sv).matches;
    const e = rr.opportunities.find(o => o.elementId === 'e');
    check('v2.3 真递归:blocker 伴被埋 → unit 1.5 → matchCostR 3.5 > v2.2 的 3.0',
      e.launcher.tileId === 1 && e.target.tileId === 0
        && e.matchCost === 3 && e.target.acquireCost === 2
        && e.target.acquireCostR === 2.5 && e.matchCostR === 3.5,
      `acq=${e.target.acquireCost} acqR=${e.target.acquireCostR} mR=${e.matchCostR}`);
  }
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
