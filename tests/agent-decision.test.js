// ============================================================================
// agent-decision.test.js — ③决策 扫描梯瀑布 + 揭示预演择优 回归测试(node 直跑,不依赖 cc)
//
// 编译(纯逻辑文件,无 cc 依赖):
//   npx -y -p typescript@5.4.5 tsc assets/scripts/core/*.ts \
//     assets/scripts/agent/Perception.ts assets/scripts/agent/Analysis.ts \
//     assets/scripts/agent/Ladder.ts assets/scripts/agent/Runner.ts \
//     --rootDir assets/scripts --outDir temp/v3check \
//     --module commonjs --target es2019 --skipLibCheck --esModuleInterop
//   node tests/agent-decision.test.js
// ============================================================================

const { Board } = require('../temp/v3check/core/Board');
const { buildFilledLevel } = require('../temp/v3check/core/RandomFill');
const LAYOUT = require('../assets/data/layouts/test_layout.json');
const { perceive } = require('../temp/v3check/agent/Perception');
const { analyze, simulateReveal, verifyMatches } = require('../temp/v3check/agent/Analysis');
const { decideByLadder, ladderPolicy, slotCloseRung, pairCompleteRung, digRung, selectDigMatch, selectDig,
  compareDigMatch, advanceOf,
  exploreRung, wanderRung, defaultLadder, pickDelta, simulateAnalysisAfterPick, simulateViewAfterPick,
  comparePickDelta, deltaScore } = require('../temp/v3check/agent/Ladder');
const { runAgent } = require('../temp/v3check/agent/Runner');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${detail ?? ''}`); }
}


/** 最小合成牌 */
const mkT = (tileId, elementId, gx, gy, layer) =>
  ({ elementId, variant: 'FULL', gx, gy, layer, tileId, status: 'pile', slotIndex: null });

/** 平铺盘:4 元素 × 1 对,8 张全可点,零遮挡 */
function flatLevel() {
  const els = ['E1', 'E2', 'E3', 'E4'].map(e => ({ elementId: e, displayName: e, color: '#fff' }));
  const seq = ['E1', 'E1', 'E2', 'E2', 'E3', 'E3', 'E4', 'E4'];
  const tiles = seq.map((e, i) => ({ elementId: e, variant: 'FULL', gx: i * 8, gy: 2, layer: 0 }));
  return { board: { w: 64 + 8, h: 14 }, elements: els, tiles };
}

/** 决策上下文(固定 rng 保证断言确定性) */
function buildCtx(board, rng = () => 0.42) {
  const view = perceive(board);
  const analysis = analyze(view);
  const clickable = view.perceived.filter(t => analysis.derived.get(t.tileId)?.clickable === true);
  return { view, analysis, clickable, rng };
}

/** 关卡定义速写:元素表由牌面自动推导 */
const level = (w, h, spec) => {
  const tiles = spec.map(([elementId, gx, gy, layer], i) =>
    ({ elementId, variant: 'FULL', gx, gy, layer, tileId: i }));
  const ids = [...new Set(tiles.map(t => t.elementId))];
  return { board: { w, h }, elements: ids.map(e => ({ elementId: e, displayName: e, color: '#fff' })), tiles };
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('— 梯瀑布框架:顺序优先 / 下传 / 内置 fallback —');
{
  const ctx = buildCtx(new Board(flatLevel()));
  const ids = new Set(ctx.clickable.map(t => t.tileId));

  const fb = decideByLadder([], ctx);
  check('空梯 → 内置 fallback 兜底且选牌可点',
    fb.reason.rule === 'fallback' && ids.has(fb.action.tileId));

  const opA = { action: { type: 'pick', tileId: [...ids][0] },
    reason: { rule: 'dig', note: 'A' },
    expectation: { pairCompletes: false, slotAfter: 1, exposes: [], confidence: 'likely' } };
  const opB = { ...opA, reason: { rule: 'forced', note: 'B' } };
  const win = decideByLadder([
    { rule: 'dig', decide: () => opA },
    { rule: 'forced', decide: () => opB },
  ], ctx);
  check('顺序优先:首个非空梯胜出', win.reason.rule === 'dig' && win.reason.note === 'A');

  const passDown = decideByLadder([
    { rule: 'dig', decide: () => null },
    { rule: 'forced', decide: () => opB },
  ], ctx);
  check('null 下传:空梯让位后续', passDown.reason.rule === 'forced');
}

console.log('— 梯语义:slot-close / pair-complete / wander —');
{
  // slot-close:槽内 E1a(tileId 0)+ 可点伴 E1b(tileId 1)
  const board = flatLevel();
  const b1 = new Board(board);
  b1.pick(0);
  const ctx = buildCtx(b1);
  const op = slotCloseRung.decide(ctx);
  check('slot-close:槽内伴可点即触发,拿伴(tileId 1)',
    op !== null && op.reason.rule === 'slot-close' && op.action.tileId === 1);
  check('slot-close 预期:闭对 / slotAfter = 0(1-1) / certain',
    op.expectation.pairCompletes === true && op.expectation.slotAfter === 0
    && op.expectation.confidence === 'certain');

  // slot-close 候选来源 = MatchReport 的 close 型(2026-11-24):
  //   动作 = 该匹配的 target;reason 携带 matchCost / 空槽数
  {
    const closes = ctx.analysis.matches.opportunities.filter(o => o.type === 'close');
    check('slot-close 候选来自 MatchReport:恰 1 个 close 型,动作 = 其 target',
      closes.length === 1 && closes[0].launcher.inSlot
      && op.action.tileId === closes[0].target.tileId);
    check('slot-close reason 注明消耗:close 型峰值 1 / 空槽数 3',
      closes[0].matchCost === 1 && ctx.analysis.matches.emptySlots === 3
      && op.reason.note.includes('消耗 1/3 格'),
      `note="${op.reason.note}"`);
  }

  // slot-close 边界 A:槽内持伴,伴**真正被压** → MatchReport 为 hold 型(launcher 在槽内)
  //   → slot-close 让位(行为边界不变,归后续梯);即便该 hold 型可执行也不收。
  //   几何(X 放 (9,2,L1),探针核实):X 的顶面盖住 E1b 上沿 2 行(16 unit² = 20% > 18%)
  //   → E1b 不可点;X 的侧面在 E1b 下方,不擦 E1b;E1b 仍大部分可见(进感知集、可识别);
  //   X 不压 E1a。该配对的模拟计划 = 先拿 X(tileId 4)再拿 E1b,峰值 2。
  //   (2026-11-24 之前这里用的是 X(2,2,L1):那其实只盖住 E1b 一丝,E1b 可点——见边界 B)
  {
    const bHeld = new Board(level(50, 40, [
      ['E1', 0, 10, 0], ['E1', 9, 10, 0], ['E2', 18, 10, 0], ['E2', 27, 10, 0],
      ['X', 9, 2, 1],
    ]));
    const picked = bHeld.pick(0);           // E1a 入槽
    const ctxHeld = buildCtx(bHeld);
    const held = ctxHeld.analysis.matches.byElement.get('E1')?.[0];
    const preOk = picked.ok && bHeld.slotCount() === 1
      && held !== undefined && held.type === 'hold' && held.launcher.inSlot
      && held.target.tileId === 1 && held.target.revealCount > 0
      && ctxHeld.analysis.derived.get(1)?.clickable === false;
    check('边界 A·前置:E1a 入槽;伴 E1b 被压 → MatchReport 记为 hold 型(launcher 在槽内,target = E1b)',
      preOk,
      `pick=${picked.reason ?? 'ok'} slot=${bHeld.slotCount()} type=${held?.type} launcherInSlot=${held?.launcher.inSlot} target=${held?.target?.tileId} targetClosure=${held?.target?.revealCount}`);
    const hv = held !== undefined ? verifyMatches(ctxHeld.view, ctxHeld.analysis, [held])[0] : null;
    check('边界 A:伴被压时 slot-close 让位(不收 hold 型,即便可执行);计划 = 先拿压它的 X 再拿伴',
      preOk && hv !== null && hv.executable === true && hv.cost.picks.join(',') === '4,1'
      && slotCloseRung.decide(ctxHeld) === null,
      `held.type=${held && held.type} peak=${hv && hv.matchCost} picks=${hv && hv.cost.picks.join(',')} empty=${ctxHeld.analysis.matches.emptySlots}`);
  }

  // slot-close 边界 B:伴**可点但闭包不为 0**(只被不足阈值的细条盖住)→ 按可点性判为 close 型。
  //   2026-11-24 核对并修正:此前类型按「闭包大小为 0」判,这种配对会被记成 hold——
  //   slot-close 让位,随后 dig 梯会先把那一张细条牌拿掉,其实伴直接可点。
  //   几何(X 放 (2,2,L1)):X 的顶面只盖住 E1b 左下角 1×2(2 unit² = 2.5% < 18%),
  //   侧面不擦 E1b → E1b 可点,闭包 = {X}
  {
    const bSliver = new Board(level(50, 40, [
      ['E1', 0, 10, 0], ['E1', 9, 10, 0], ['E2', 18, 10, 0], ['E2', 27, 10, 0],
      ['X', 2, 2, 1],
    ]));
    bSliver.pick(0);
    const ctxS = buildCtx(bSliver);
    const sliver = ctxS.analysis.matches.byElement.get('E1')?.[0];
    check('边界 B·前置:伴 E1b 可点,但闭包不为 0(被细条盖住)',
      ctxS.analysis.derived.get(1)?.clickable === true
      && (ctxS.analysis.closureSize.get(1) ?? 0) > 0,
      `clickable=${ctxS.analysis.derived.get(1)?.clickable} closure=${ctxS.analysis.closureSize.get(1)}`);
    check('边界 B:类型看可点性 → close 型(峰值 1,计划只有「拿伴」一步)',
      sliver !== undefined && sliver.type === 'close' && sliver.matchCost === 1
      && sliver.cost.picks.join(',') === '1',
      `type=${sliver?.type} peak=${sliver?.matchCost} picks=${sliver?.cost.picks.join(',')}`);
    const opS = slotCloseRung.decide(ctxS);
    check('边界 B:slot-close 直接收下(拿伴 tileId 1)',
      opS !== null && opS.action.tileId === 1, `op=${opS && opS.action.tileId}`);
  }

  // pair-complete:无槽双亮对 → 预期不闭对(伴在堆不在槽)
  const ctx2 = buildCtx(new Board(board));
  const op2 = pairCompleteRung.decide(ctx2);
  check('pair-complete:双亮对触发',
    op2 !== null && op2.reason.rule === 'pair-complete');
  check('pair-complete 预期:不闭对 / slotAfter = 1 / likely',
    op2.expectation.pairCompletes === false && op2.expectation.slotAfter === 1
    && op2.expectation.confidence === 'likely');

  // 未识别('?')双亮不触发(身份不可知不参与配对认知)
  const sv = { perceived: [mkT(0, '?', 0, 2, 0), mkT(1, '?', 8, 2, 0)],
    slot: [], exposure: new Map(), totalPileCount: 2 };
  const aQ = analyze(sv);
  const ctxQ = { view: sv, analysis: aQ,
    clickable: sv.perceived.filter(t => aQ.derived.get(t.tileId)?.clickable), rng: () => 0.42 };
  check('pair-complete:未识别(?)双亮不触发', pairCompleteRung.decide(ctxQ) === null);

  // wander:全独元素盘(无任何配对信号)→ 触发;另两梯让位
  const els = ['U1', 'U2', 'U3', 'U4'].map(e => ({ elementId: e, displayName: e, color: '#fff' }));
  const tilesU = els.map((e, i) => ({ elementId: e.elementId, variant: 'FULL', gx: i * 8, gy: 2, layer: 0 }));
  const ub = new Board({ board: { w: 40, h: 14 }, elements: els, tiles: tilesU });
  const uctx = buildCtx(ub);
  const wop = wanderRung.decide(uctx);
  check('wander:无配对信号盘触发', wop !== null && wop.reason.rule === 'wander');
  check('wander 选牌可点', uctx.clickable.some(t => t.tileId === wop.action.tileId));
  check('全独盘:slot-close / pair-complete 均让位',
    slotCloseRung.decide(uctx) === null && pairCompleteRung.decide(uctx) === null);
}

console.log('— 优先级实证:slot-close 先于 pair-complete(槽压峰值更低) —');
{
  // 槽 1 张 + 三组双亮对并存:两梯均可触发 → 阵序决定行为
  const board = flatLevel();
  const b = new Board(board);
  b.pick(0);
  const ctx = buildCtx(b);
  check('阵序即优先级:[slotClose, pairComplete] → slot-close',
    decideByLadder([slotCloseRung, pairCompleteRung], ctx).reason.rule === 'slot-close');
  check('阵序即优先级:[pairComplete, slotClose] → pair-complete',
    decideByLadder([pairCompleteRung, slotCloseRung], ctx).reason.rule === 'pair-complete');

  // 2026-11-24 起 pair-complete 只收可执行的 double(空槽 < 2 让位),
  // 「逆序梯连续持半致槽满判负」已被门槛排除——逆序梯同样清盘。
  // 但先后顺序仍影响槽压峰值:先闭合再开对,手里不会同时压多张半张
  {
    const seedBoard = () => { const b = new Board(board); b.pick(0); return b; };   // 槽内预置 E1a
    const fwd = runAgent(seedBoard(), { seed: 7, decision: ladderPolicy() });
    const inv = runAgent(seedBoard(), { seed: 7,
      decision: ladderPolicy([pairCompleteRung, slotCloseRung, wanderRung]) });
    check('门槛生效:逆序梯不再判负(空槽不足时 pair-complete 让位),同样清盘',
      fwd.outcome === 'cleared' && inv.outcome === 'cleared' && fwd.picks === 7 && inv.picks === 7,
      `fwd=${fwd.outcome}/${fwd.picks} inv=${inv.outcome}/${inv.picks}`);
    check('先后顺序仍影响槽压峰值:正序 1 < 逆序 3(逆序先开对,手里同时压 3 张半张)',
      fwd.maxSlotPressure === 1 && inv.maxSlotPressure === 3,
      `fwd 峰值=${fwd.maxSlotPressure} inv 峰值=${inv.maxSlotPressure}`);
  }
}

console.log('— Runner 集成:defaultLadder 通关 + 预期对账 + 可重放 —');
{
  const r1 = runAgent(new Board(flatLevel()), { seed: 7, decision: ladderPolicy() });
  check('defaultLadder 清盘(8 pick / 4 对)',
    r1.outcome === 'cleared' && r1.picks === 8 && r1.pairsEliminated === 4,
    `outcome=${r1.outcome} picks=${r1.picks}`);
  check('每步轨迹携带 operation(rule/expectation)',
    r1.steps.every(s => s.operation && s.operation.rule && s.operation.expectation));
  check('预期对账:pairCompletes === 实际 paired,slotAfter === 实际槽位',
    r1.steps.every(s => s.operation.expectation.pairCompletes === s.paired
      && s.operation.expectation.slotAfter === s.slotAfter));
  check('逐对交替节奏:偶数步 pair-complete(握半启动)/ 奇数步 slot-close(闭合)',
    r1.steps.every((s, i) => s.operation.rule === (i % 2 === 0 ? 'pair-complete' : 'slot-close')));
  check('默认梯四梯:slot-close → pair-complete → dig → explore(启动梯已于 2026-11-25 移除)',
    defaultLadder.map(r => r.rule).join('→') === 'slot-close→pair-complete→dig→explore');

  const r2 = runAgent(new Board(flatLevel()), { seed: 7, decision: ladderPolicy() });
  check('同 seed 同梯可重放(选牌与规则逐字段一致)',
    r2.outcome === r1.outcome && r1.steps.length === r2.steps.length
    && r1.steps.every((s, i) => s.chosenTile === r2.steps[i].chosenTile
      && s.operation.rule === r2.steps[i].operation.rule));

  const legacy = runAgent(new Board(flatLevel()), { seed: 7 });
  check('legacy 路径不受影响(operation 为空,终局合法)',
    legacy.steps.every(s => s.operation === undefined)
    && ['cleared', 'slot_full', 'no_clickable'].includes(legacy.outcome));
}

console.log('— 拾取差分 pickDelta:三级字典序 + 预演范围 + 纯函数 —');
{
  const D = (newExecutable, upgrades, peakDrop) => ({ newExecutable, upgrades, peakDrop, detail: null });

  // 一、三级优先级(2026-11-24 设计裁定):新增可执行 > 类型升级 > 峰值下降总量
  check('第 1 级优先:新增可执行 1 个胜过任意多的升级与峰值下降',
    comparePickDelta(D(1, 0, 0), D(0, 99, 9999)) > 0);
  check('第 2 级优先:升级 1 次胜过任意多的峰值下降',
    comparePickDelta(D(0, 1, 0), D(0, 0, 9999)) > 0);
  check('第 3 级兜底:前两级持平时比峰值下降总量',
    comparePickDelta(D(0, 0, 5), D(0, 0, 3)) > 0);
  check('三级全同 → 平级(由调用方按 tileId 决胜)',
    comparePickDelta(D(2, 1, 4), D(2, 1, 4)) === 0);
  check('反向:被超越者返回负数',
    comparePickDelta(D(0, 0, 1), D(0, 1, 0)) < 0);
  check('标量化与字典序保序:deltaScore 的大小关系与 comparePickDelta 一致',
    [D(1, 0, 0), D(0, 99, 9999), D(0, 1, 0), D(0, 0, 9999), D(0, 0, 3)].every((a, _, arr) =>
      arr.every(b => Math.sign(comparePickDelta(a, b)) === Math.sign(deltaScore(a) - deltaScore(b)))));

  // 二、纯函数:预演不修改原主观视图与真实 Board(无需状态恢复)
  {
    const b = new Board(flatLevel());
    b.pick(0); b.pick(2);                         // 槽内 2 张
    const v = perceive(b);
    const ctx = buildCtx(b);
    const snapView = JSON.stringify(v.perceived.map(t => [t.tileId, t.elementId, t.status, t.slotIndex]))
      + JSON.stringify(v.slot.map(t => [t.tileId, t.elementId, t.slotIndex]));
    const snapBoard = JSON.stringify(b.allTiles().map(t => [t.tileId, t.status, t.slotIndex]));
    for (const t of ctx.clickable) { pickDelta(t.tileId, ctx); simulateViewAfterPick(t.tileId, v); }
    const viewNow = JSON.stringify(v.perceived.map(t => [t.tileId, t.elementId, t.status, t.slotIndex]))
      + JSON.stringify(v.slot.map(t => [t.tileId, t.elementId, t.slotIndex]));
    check('纯函数:多次预演后原主观视图逐字段不变',
      viewNow === snapView, `before=${snapView} after=${viewNow}`);
    check('纯函数:多次预演后真实 Board 不变',
      JSON.stringify(b.allTiles().map(t => [t.tileId, t.status, t.slotIndex])) === snapBoard);
    check('预演结果不共享可变结构:返回视图的 slot 是新对象',
      simulateViewAfterPick(ctx.clickable[0].tileId, v).slot[0] !== v.slot[0]);
  }

  // 三、槽内状态纳入预演:闭对离场 → 合并后的资源余量
  //   盘:槽内 E1a(0)、E3a(4);E1b(1) 可点。拿 E1b 与 E1a 闭对 → 槽 2 → 1,空槽 2 → 3
  {
    const b = new Board(flatLevel());
    b.pick(0); b.pick(4);
    const ctx = buildCtx(b);
    const sim = simulateAnalysisAfterPick(1, ctx);
    check('闭对离场:预演后槽内 2 → 1(E1a 与 E1b 一并离场),空槽 2 → 3',
      ctx.view.slot.length === 2 && sim.matches.emptySlots === 3
      && !sim.matches.opportunities.some(o => o.elementId === 'E1'));
    const d = pickDelta(1, ctx);
    check('差分:E1 自身的匹配消失(E1:close 闭对离场);无新增可执行、无升级',
      d.detail.disappeared.join(',') === 'E1:close' && d.newExecutable === 0 && d.upgrades === 0,
      `detail=${JSON.stringify(d.detail)}`);
  }

  // 四、预演范围:只在当前感知集上——新露出的牌不进预演(2026-11-24 设计裁定)
  //   盘:Q(0)@(8,2,L0) 被 P(1)@(8,2,L1) 满压(Q 完全不可见);P 可点。
  //   拿 P 后 Q 真实会露出,但预演看不到 Q:感知集只少 P,不会多出 Q
  {
    const b = new Board(level(24, 24, [['Q', 8, 2, 0], ['P', 8, 2, 1]]));
    const ctx = buildCtx(b);
    check('前置:Q 被 P 满压,不在感知集;感知集仅 P,且 P 可点',
      !ctx.view.perceived.some(t => t.elementId === 'Q') && ctx.view.perceived.length === 1
      && ctx.clickable.length === 1 && ctx.clickable[0].elementId === 'P');
    const simView = simulateViewAfterPick(1, ctx.view);
    check('预演只在当前感知集上:拿 P 后预演的牌堆为空、P 入槽,不含尚未露出的 Q',
      simView.perceived.length === 0 && simView.slot.length === 1 && simView.slot[0].elementId === 'P',
      `perceived=${JSON.stringify(simView.perceived.map(t => t.elementId))} slot=${JSON.stringify(simView.slot.map(t => t.elementId))}`);
    // 对照:真实执行后 Q 进入感知集(由下一轮 ①感知 → ②分析 纳入)
    b.pick(1);
    const after = perceive(b);
    check('对照:真实执行后 Q 进入感知集(操作落定后由新一轮分析纳入)',
      after.perceived.length === 1 && after.perceived[0].elementId === 'Q',
      `perceived=${JSON.stringify(after.perceived.map(t => t.elementId))}`);
  }
}

// 几何备忘:TILE 8×10、侧面 2;blocked = 覆盖并集 > 14.4 unit²(≥15)或跨层侧边擦及。
// 骑缝上位牌(偏移 4,自底向上 −2)压左下/右下牌各 4×4 = 16,压左上/右上牌各 4×8 = 32。
console.log('— 揭示预演 simulateReveal:clickable 的激活类型 —');
{
  // a0(0)'A'@(16,2,L0) 入槽;t1(1)'A'@(0,2,L0)、t2(2)'B'@(0,16,L0) 仅被 m(3)'M'@(0,12,L1) 压
  //   m 全投影 [0,8]×[10,22]:压 t1 16、压 t2 48
  const b = new Board(level(24, 28, [['A', 16, 2, 0], ['A', 0, 2, 0], ['B', 0, 16, 0], ['M', 0, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  check('前置:t1/t2 被压,m 可点,槽内有 A',
    !ctx.clickable.some(t => t.tileId === 1) && !ctx.clickable.some(t => t.tileId === 2)
    && ctx.clickable.some(t => t.tileId === 3) && ctx.view.slot.length === 1);
  const f = simulateReveal(3, ctx.view, ctx.analysis);
  check('预演 clickable:t1 closes(槽内有 A)/ t2 lone(无已知伴),按 tileId 升序',
    f.clickable.length === 2 && f.clickable[0].tileId === 1 && f.clickable[0].activation === 'closes'
    && f.clickable[1].tileId === 2 && f.clickable[1].activation === 'lone');
  check('预演求和:activationSum = 1.0 + 0.2 = 1.2;nonClickable 空',
    near(f.activationSum, 1.2) && f.nonClickable.length === 0 && f.nearCount === 0);
  check('hiddenRisk 当前恒 0(用户裁定:计算暂缓)', f.clickable.every(c => c.hiddenRisk === 0));

  // ⑤对账面:本盘无隐藏牌 → 主观预演 = 真值(实际拿走 m 后的可点集)
  b.pick(3);
  const after = buildCtx(b);
  check('无隐藏牌盘:预演 exposes = 实际新可点牌',
    JSON.stringify(f.clickable.map(c => c.tileId)) === JSON.stringify([1, 2])
    && JSON.stringify(after.clickable.map(t => t.tileId)) === JSON.stringify([1, 2]));
}
{
  // pairs 的两种来路:同批揭出的同元素 / 已可点的同元素
  //   c1(0)'C'@(0,2,L0) c2(1)'C'@(0,16,L0) 仅被 m(3)'M'@(0,12,L1) 压
  //   t(4)'D'@(16,16,L0) 仅被 m2(5)'E'@(16,12,L1) 压;同元素 d0(2)@(24,2,L0) 已可点
  const ctx = buildCtx(new Board(level(32, 28, [
    ['C', 0, 2, 0], ['C', 0, 16, 0], ['D', 24, 2, 0], ['M', 0, 12, 1], ['D', 16, 16, 0], ['E', 16, 12, 1],
  ])));
  const f1 = simulateReveal(3, ctx.view, ctx.analysis);
  check('pairs·同批:揭出的 c1/c2 同元素 → 各 pairs,activationSum = 1.6',
    f1.clickable.length === 2 && f1.clickable.every(c => c.activation === 'pairs')
    && near(f1.activationSum, 1.6), `sum=${f1.activationSum}`);
  const f2 = simulateReveal(5, ctx.view, ctx.analysis);
  check('pairs·已有:揭出的 t 有已可点的同元素 d0 → pairs,activationSum = 0.8',
    f2.clickable.length === 1 && f2.clickable[0].activation === 'pairs'
    && near(f2.activationSum, 0.8), `sum=${f2.activationSum}`);
}
{
  // nonClickable:拿走 m 后仍被压的目标——剩余遮挡者可点 = near,否则 far
  //   t(0)'T'@(8,2,L0)  面 [8,16]×[2,12]:被 n 盖 40、被 m 盖 16,露出 32
  //   n(1)'N'@(4,2,L1)  面 [4,12]×[2,12]:压 t 的 [8,12]×[2,12] = 40
  //   m(2)'M'@(8,12,L1) 压 t 的 [8,16]×[10,12] = 16(被假想移除)
  //   near 盘:n 可点 → 拿走 m 后 t 再拿 n 即可点
  //   far  盘:另加 q(3)'Q'@(0,2,L2) 面 [0,8]×[2,12] 压 n 的 [4,8]×[2,12] = 40
  //          (n 仍露出 40 → 在感知集内但被压);q 与 t 的 x 区间不交,不直接压 t
  //   注:完全被盖的牌对代理不存在(exposedArea = 0 → 不进感知集),
  //       不能靠「把 n 盖死」来让 n 不可点——须留它露出、只让它被压
  const els = ['T', 'N', 'M', 'Q'].map(e => ({ elementId: e, displayName: e, color: '#fff' }));
  const mk = (e, gx, gy, layer) => ({ elementId: e, variant: 'FULL', gx, gy, layer });
  const base = [mk('T', 8, 2, 0), mk('N', 4, 2, 1), mk('M', 8, 12, 1)];
  const ctxN = buildCtx(new Board({ board: { w: 20, h: 24 }, elements: els, tiles: base }));
  check('前置(near 盘):m、n 可点,t 被压',
    ctxN.clickable.some(t => t.tileId === 1) && ctxN.clickable.some(t => t.tileId === 2)
    && !ctxN.clickable.some(t => t.tileId === 0));
  const fn = simulateReveal(2, ctxN.view, ctxN.analysis);
  check('near:拿走 m 后 t 仍被 n 压,但 n 可点 → near;activationSum 0',
    fn.clickable.length === 0 && fn.nonClickable.length === 1 && fn.nonClickable[0].near === true
    && fn.nearCount === 1 && fn.activationSum === 0);

  const ctxF = buildCtx(new Board({ board: { w: 20, h: 24 }, elements: els,
    tiles: [...base, mk('Q', 0, 2, 2)] }));
  const ff = simulateReveal(2, ctxF.view, ctxF.analysis);
  check('前置(far 盘):n 被压但仍被感知,q/m 可点,t 被压',
    ctxF.view.perceived.some(t => t.tileId === 1) && !ctxF.clickable.some(t => t.tileId === 1)
    && [2, 3].every(id => ctxF.clickable.some(t => t.tileId === id))
    && !ctxF.clickable.some(t => t.tileId === 0));
  check('far:t 的剩余遮挡者 n 被压不可点 → far;nearCount 0',
    ff.nonClickable.length === 1 && ff.nonClickable[0].near === false && ff.nearCount === 0,
    JSON.stringify(ff.nonClickable));
}

console.log('— dig 梯(基础数据选择):候选来源 / 排序 / 动作 / 门槛 / 端到端 —');
// 2026-11-24:原 chain 梯整体移除——借槽两步闭合的两类机会在 MatchReport 中均为
// 可执行的 hold 型匹配(峰值 2),由 dig 梯(除 close / double 外的匹配)覆盖。
// 2026-11-25:报告期全量清单,且对所有 hold / dig 配对逐条验算(消耗与滞留牌);
// dig 出手时直接读报告择优:可执行 → 槽内遗留最少 → 首牌拾取差分最优。
{
  // DG1 候选来源:close 型、double 型归前两梯;可执行的 hold / dig 型归 dig 梯
  //   槽:u0(0)'U' x0(4)'X';u(1)'U' 可点 → U 为 close;p(2) p(3)'P' → double
  //   b(5)'X' 被 a(6)'A'@(40,12,L1) 压 → X 为 hold(峰值 2,空槽 2 → 可执行)
  //   z(7) 被 n(8) 压、z'(9) 被 n'(10) 压 → Z 为 dig(峰值 4 > 2 → 不可执行)
  const b = new Board(level(80, 24, [['U', 0, 2, 0], ['U', 8, 2, 0], ['P', 16, 2, 0], ['P', 24, 2, 0],
    ['X', 32, 2, 0], ['X', 40, 2, 0], ['A', 40, 12, 1], ['Z', 56, 2, 0], ['N', 56, 12, 1],
    ['Z', 72, 2, 0], ['N2', 72, 12, 1]]));
  b.pick(0); b.pick(4);
  const ctx = buildCtx(b);
  const shown = ctx.analysis.matches.opportunities.map(o =>
    `${o.elementId}:${o.type}${o.executable ? ':可执行' : ':不可执行'}`).join(' ');
  check('前置:报告全量清单逐条验算——U close(可执行)、P double(可执行)、X hold(可执行)、Z dig(不可执行);空槽 2',
    shown === 'U:close:可执行 P:double:可执行 X:hold:可执行 Z:dig:不可执行' && ctx.analysis.matches.emptySlots === 2,
    shown);
  check('候选来源:可执行的 hold / dig 归 dig 梯 → 唯一可选 X',
    (selectDigMatch(ctx) || {}).elementId === 'X');
  const op = digRung.decide(ctx);
  check('dig 出手:rule = dig,reason.match 结构化记录所选匹配(X / hold / 启动 4 / 目标 5 / 消耗 2)',
    op !== null && op.reason.rule === 'dig' && op.action.tileId === 6
      && JSON.stringify(op.reason.match) === JSON.stringify({ elementId: 'X', type: 'hold', launcher: 4, target: 5, matchCost: 2 }),
    `pick=${op && op.action.tileId} match=${op && JSON.stringify(op.reason.match)}`);
    // 2026-11-25 来源规则:模拟开始时槽内原有的牌只跟闭包内的牌配。
    //   旧实现在算 X 的 hold 时,会顺手把槽内原有的 0(U)跟可点的 1(U)消掉 ——
    //   那是 U 的 close,混进了 X 的账里,计划因此多出 2 步。现在不消,计划只剩 2 步。
    check('reason 注明消耗与空槽数、到配对完成的拿牌数、候选规模',
      op.reason.note.includes('消耗 2/2 格') && op.reason.note.includes('到配对完成 2 拿')
      && op.reason.note.includes('候选 1/2 对'),
      `note="${op.reason.note}"`);
    check('来源规则:X 的计划只含挖掘动作(拿 6 挖开 5 → 拿 5 与槽内 4 配),不夹带原有槽内牌 0 的配对',
      JSON.stringify(ctx.analysis.matches.opportunities.find(o => o.elementId === 'X').cost.picks) === '[6,5]',
      `picks=${JSON.stringify(ctx.analysis.matches.opportunities.find(o => o.elementId === 'X').cost.picks)}`);
}
{
  // DG2 排序:可执行 → 槽内遗留最少 →(同遗留)首牌差分 → 首牌 tileId → elementId
  //   槽:x0(0)'X';b(1)'X' 被 a(2)'A'@(8,12,L1) 压 → X 为 hold(峰值 2)
  //   y(3)'Y' 可点,y'(4)'Y' 被 b'(5)'B'@(32,12,L1) 压 → Y 为 hold(峰值 3)
  const b = new Board(level(48, 24, [['X', 0, 2, 0], ['X', 8, 2, 0], ['A', 8, 12, 1],
    ['Y', 24, 2, 0], ['Y', 32, 2, 0], ['B', 32, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  const costs = ctx.analysis.matches.opportunities.map(o => `${o.elementId}:${o.type}:${o.matchCost}`).join(' ');
  check('前置:两个可执行的 hold——X 峰值 2、Y 峰值 3;空槽 3',
    costs === 'X:hold:2 Y:hold:3' && ctx.analysis.matches.emptySlots === 3, costs);
  check('排序:遗留少者先(X 遗留 1 张 < Y 的 2 张;恰与消耗同序)→ 选 X,动作 = 其计划第一步 a(2)',
    (selectDigMatch(ctx) || {}).elementId === 'X' && digRung.decide(ctx).action.tileId === 2);
  // 同遗留同消耗并列、结构对称(首牌差分并列)→ 首牌 tileId 小者先(L 的首牌 0 < T 的 3)
  const ctxT = buildCtx(new Board(level(48, 24, [['L', 0, 2, 0], ['L', 8, 2, 0], ['M', 0, 12, 1],
    ['T', 24, 2, 0], ['T', 32, 2, 0], ['N', 24, 12, 1]])));
  check('排序:同遗留同消耗、首牌差分并列 → 首牌 tileId 小者先(L 的首牌 0 < T 的 3)',
    ctxT.analysis.matches.opportunities.map(o => `${o.elementId}:${o.type}`).join(' ') === 'L:hold T:hold'
      && (selectDigMatch(ctxT) || {}).elementId === 'L');
}
{
  // DG3 动作 = 消除模拟计划的第一次拾取(可执行性正是针对这套顺序得出的)
  //   启动牌在槽内(X 半张,目标牌 b(1) 被 a(2) 压)→ 先拿遮挡者
  const bS = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  bS.pick(0);
  const inSlot = buildCtx(bS);
  check('动作·启动牌在槽内:拿目标牌的遮挡者(计划 2→1 → 拿 2)',
    inSlot.analysis.matches.opportunities[0].cost.picks.join(',') === '2,1'
      && digRung.decide(inSlot).action.tileId === 2);
  //   启动牌 a(1) 可点、目标牌 b(0) 被压 → 先拿启动牌(它入槽等待)
  const lit = buildCtx(new Board(level(16, 24, [['Y', 0, 2, 0], ['Y', 0, 12, 1]])));
  check('动作·启动牌可点:拿启动牌(计划 1→0 → 拿 1)', digRung.decide(lit).action.tileId === 1);
  //   两张都被压(dig 型)→ 先拿启动牌的遮挡者
  //     z(0)'Z' 被 n(1)'N'@(0,12,L1) 压;z'(2)'Z' 被 n'(3)'N2'@(16,12,L1) 压;空槽 4,峰值 4
  const dig = buildCtx(new Board(level(24, 24, [['Z', 0, 2, 0], ['N', 0, 12, 1], ['Z', 16, 2, 0], ['N2', 16, 12, 1]])));
  const z = dig.analysis.matches.opportunities[0];
  const opD = digRung.decide(dig);
  check('动作·dig 型:拿启动牌的遮挡者(计划 1→0→3→2 → 拿 1);reason.match 记 dig / 消耗 4',
    z.type === 'dig' && z.matchCost === 4 && z.executable && z.cost.picks.join(',') === '1,0,3,2'
      && opD.action.tileId === 1
      && JSON.stringify(opD.reason.match) === JSON.stringify({ elementId: 'Z', type: 'dig', launcher: 0, target: 2, matchCost: 4 }),
    `pick=${opD && opD.action.tileId} match=${opD && JSON.stringify(opD.reason.match)}`);
}
{
  // DG4 门槛:验算后不可执行的匹配不收(空槽 1 时 hold 峰值 2 > 1)
  const spec = [['X', 0, 2, 0], ['A', 0, 12, 1], ['X', 16, 2, 0], ['U', 24, 2, 0], ['V', 32, 2, 0]];
  const b = new Board(level(40, 24, spec));
  b.pick(2); b.pick(3); b.pick(4);
  const ctx = buildCtx(b);
  const only = ctx.analysis.matches.opportunities;
  check('空槽 1:唯一的 hold 不可执行(报告期已验算,峰值 2 > 1)→ dig 让位',
    ctx.analysis.matches.emptySlots === 1 && only.length === 1 && only[0].type === 'hold'
      && only[0].cost !== undefined && only[0].executable === false
      && selectDigMatch(ctx) === null && digRung.decide(ctx) === null);
  // DG5 负例:只有 double(归 pair-complete)→ dig 让位
  const flat = buildCtx(new Board(flatLevel()));
  check('只有 double 型匹配 → dig 让位', selectDigMatch(flat) === null && digRung.decide(flat) === null);
}
{
  // DG6 端到端(defaultLadder)
  //   启动牌可点的 hold:槽空、无 double → dig 握半启动 → slot-close 闭合 → 清盘
  //   (启动梯已于 2026-11-25 移除;平盘的槽空首步由 pair-complete 接手,这里没有 double)
  const r = runAgent(new Board(level(16, 24, [['Y', 0, 2, 0], ['Y', 0, 12, 1]])), { seed: 7, decision: ladderPolicy() });
  check('端到端·hold:dig 握半启动 → slot-close 闭合,2 pick 清盘',
    r.outcome === 'cleared' && r.picks === 2 && r.steps.map(s => s.operation.rule).join('→') === 'dig→slot-close',
    r.steps.map(s => s.operation.rule).join('→'));
  //   级联(三层):a(3)'A'@(4,8,L2) 压 b(2)'X'@(0,2,L1);b 全压 a2(1)'A'@(0,2,L0);槽内 sX(0)'X'
  //   dig 拿 a → slot-close 拿 b 与 sX 闭合 → a2 失去遮挡 → slot-close 拿 a2 与槽内的 a 闭合
  const b5 = new Board(level(24, 20, [['X', 16, 2, 0], ['A', 0, 2, 0], ['X', 0, 2, 1], ['A', 4, 8, 2]]));
  b5.pick(0);
  const r5 = runAgent(b5, { seed: 7, decision: ladderPolicy() });
  check('端到端·级联:dig → slot-close → slot-close,3 pick 清盘',
    r5.outcome === 'cleared' && r5.picks === 3 && r5.pairsEliminated === 2
      && r5.steps.map(s => s.operation.rule).join('→') === 'dig→slot-close→slot-close',
    r5.steps.map(s => s.operation.rule).join('→'));
  //   dig 型(两张都被压):每步重估,匹配类型与消耗随挖掘推进 dig,4 → hold,3 → hold,2
  //     z(0)'Z' 被 n(1) 压;z'(2)'Z' 被 n'(3) 压;n / n' 无伴(故意留成孤儿,终局 no_clickable)
  const r6 = runAgent(new Board(level(24, 24, [['Z', 0, 2, 0], ['N', 0, 12, 1], ['Z', 16, 2, 0], ['N2', 16, 12, 1]])),
    { seed: 7, decision: ladderPolicy() });
  check('端到端·dig 型:每步重估,类型与消耗随挖掘推进(dig,4 → hold,3 → hold,2)→ slot-close 闭合',
    r6.picks === 4 && r6.pairsEliminated === 1
      && r6.steps.map(s => s.operation.rule).join('→') === 'dig→dig→dig→slot-close'
      && r6.steps.slice(0, 3).map(s => `${s.operation.match.type},${s.operation.match.matchCost}`).join('→') === 'dig,4→hold,3→hold,2'
      && r6.steps[3].paired === true,
    r6.steps.map(s => `${s.chosenTile}:${s.operation.rule}(${s.operation.match ? s.operation.match.type + ',' + s.operation.match.matchCost : ''})`).join('→'));
  // 推进效能按「所拿的牌是否纯遮挡者」变化(数值经探针核实):1/5 → 0 → 1/2
  //   两个遮挡者 n(1)、n'(3) 都无伴,谁被拿走谁就留在槽里。滞留按**拿前**计
  //   第 1 拿 n(1):纯遮挡者,在闭包 [1,3] 里 → 拿后差 3;1、3 都会滞留 → 1/(3+2) = 1/5
  //   第 2 拿 z(0):它是配对牌(可点的启动牌),不是纯遮挡者 → 效能 0。
  //     dig 仍出这一手:此时唯一可执行配对的首牌就是它(闭包 [3] 里的 3 不是首牌)
  //   第 3 拿 n'(3):纯遮挡者 → 拿后差 1、滞留 1 → 1/(1+1) = 1/2
  check('端到端·dig 型:拿纯遮挡者才有效能(1/5 → 0 → 1/2),拿配对牌为 0;随操作落盘',
    r6.steps.slice(0, 3).map(s => s.operation.advance.total).join(',') === [1 / 5, 0, 1 / 2].join(',')
    && r6.steps.slice(0, 3).every(s => s.operation.utility === s.operation.advance.total),
    r6.steps.map(s => `${s.operation.rule}:${s.operation.advance && s.operation.advance.total.toFixed(3)}`).join('→'));
}

console.log('— dig 梯:报告全量清单 + 出手时全部验算(2026-11-25 设计者定稿)—');
// 报告期把每个元素的全部候选两两配对记录并分类(close / double 即验算;hold / dig 只
// 分类不验算);dig 出手时对报告里的全部 hold / dig 配对验算(verifyMatches,与报告期
// 同一条代码路径),按字典序择优:可执行 → 槽内遗留最少 → 首牌拾取差分最优。
// 盘面几何先用探针逐一核实(temp/ 探针,未入库),再固化。
{
  // FS1 报告全量清单:同一元素的全部需挖掘配对都在(此前每元素只留获取成本最低的一条)
  //   槽:sX(0)'X';q1(1)'X' 被 b(2)'B'、c(3)'C' 压;q2(4)'X' 被 e1(5)'E'、e2(6)'E' 压(E 两张互为伴)
  const b = new Board(level(96, 24, [['X', 56, 2, 0], ['X', 8, 2, 0], ['B', 4, 12, 1], ['C', 12, 12, 1],
    ['X', 32, 2, 0], ['E', 28, 12, 1], ['E', 36, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  const xs = ctx.analysis.matches.byElement.get('X');
  const e0 = ctx.analysis.matches.byElement.get('E')[0];
  check('前置:报告为 X 记录全部 3 条需挖掘配对并逐条验算——(0,4) 峰值 2、(0,1) 峰值 3、(1,4) dig 峰值 5,按消耗升序;E 的 double 峰值 2',
    xs.length === 3
    && xs.map(o => `${o.launcher.tileId},${o.target.tileId}:${o.type}:${o.matchCost}:${o.executable}`).join(' ') === '0,4:hold:2:true 0,1:hold:3:true 1,4:dig:5:false'
    && xs.every(o => o.cost !== undefined)
    && e0.type === 'double' && e0.matchCost === 2 && e0.executable === true,
    JSON.stringify(xs.map(o => [o.launcher.tileId, o.target.tileId, o.type, o.matchCost, o.executable])));
  const op = digRung.decide(ctx);
  check('dig 出手:直接读报告 → (0,4) 峰值 2、无遗留,胜过 (0,1) 峰值 3 遗留 2;动作 = 计划第一步 e1(5)',
    op.action.tileId === 5
    && JSON.stringify(op.reason.match) === JSON.stringify({ elementId: 'X', type: 'hold', launcher: 0, target: 4, matchCost: 2 }),
    `pick=${op && op.action.tileId} match=${op && JSON.stringify(op.reason.match)}`);
  check('清单事实落盘:报告 3 对、可执行 2、涉及 1 个元素;note 注明候选规模',
    JSON.stringify(op.reason.scan) === JSON.stringify({ pairs: 3, executable: 2, elements: 1 })
    && op.reason.note.includes('候选 2/3 对'),
    `scan=${op && JSON.stringify(op.reason.scan)} note="${op && op.reason.note}"`);
  check('dig 择优 = 首牌推进效能最大者:首牌 5 效能 0.5(路线 (0,4) 拿后差 2、无滞留)胜过首牌 2 的 0.25(路线 (0,1) 拿后差 2、滞留 2)',
    op.action.tileId === 5 && op.reason.utility === 0.5
    && JSON.stringify(op.reason.advance) === JSON.stringify({ total: 0.5, elements: [
      { elementId: 'X', pairId: [0, 4], pairPicks: 2, residual: 0, offset: 0, executable: true, value: 0.5 }] })
    && JSON.stringify(op.reason.runnerUp) === JSON.stringify({ tileId: 2, score: 0.25 }),
    `utility=${op && op.reason.utility} advance=${op && JSON.stringify(op.reason.advance)} runnerUp=${op && JSON.stringify(op.reason.runnerUp)}`);
  const v = verifyMatches(ctx.view, ctx.analysis, xs);
  check('幂等重算:3 条的峰值 2 / 3 / 5,可执行 true / true / false;重复验算逐字段一致(确定性)',
    v.map(o => `${o.matchCost}:${o.executable}`).join(' ') === '2:true 3:true 5:false'
    && JSON.stringify(verifyMatches(ctx.view, ctx.analysis, v)) === JSON.stringify(v));
  check('与报告期同一条代码路径:任一条目重算逐字段一致',
    JSON.stringify(verifyMatches(ctx.view, ctx.analysis, [e0])) === JSON.stringify([e0]));
}
{
  // FS3 每元素只有一条需挖掘配对:报告 1 条、可执行 1
  //   槽:sX(0)'X';b(1)'X' 被 a(2)'A'@(0,12,L1) 压 → 报告 (0, 1) hold,峰值 2
  const b = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  const on = digRung.decide(ctx);
  check('单条配对:候选 1/1 对;动作 = 模拟计划的第一步 a(2)',
    on.action.tileId === 2
    && JSON.stringify(on.reason.match) === JSON.stringify({ elementId: 'X', type: 'hold', launcher: 0, target: 1, matchCost: 2 })
    && JSON.stringify(on.reason.scan) === JSON.stringify({ pairs: 1, executable: 1, elements: 1 })
    && on.reason.note.includes('候选 1/1 对'),
    `on=${JSON.stringify(on.reason.match)} ${JSON.stringify(on.reason.scan)}`);
  // FS4 端到端:观测记录与推进效能随轨迹落盘(Runner → StepRecord.operation)。接上面的盘(槽内已有 0)
  //   dig 拿 a(2) → slot-close 拿 1 闭合;之后只剩无伴的 a,无可点牌,终局 no_clickable
  //   dig 步:路线拿后差 1、滞留 1(A 无伴)→ 效能 0.5;slot-close 步:所拿的 1 不在任何
  //   hold / dig 的路径上(它自己那条已配掉)→ 效能 0
  const b4 = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  b4.pick(0);
  const r = runAgent(b4, { seed: 7, decision: ladderPolicy() });
  check('端到端:dig 步的轨迹带 operation.scan 与 operation.advance(0.5);slot-close 步带 advance(0)无 scan',
    r.steps.length === 2 && r.steps.map(s => s.operation.rule).join('→') === 'dig→slot-close'
    && JSON.stringify(r.steps[0].operation.scan) === JSON.stringify({ pairs: 1, executable: 1, elements: 1 })
    && r.steps[0].operation.match.target === 1 && r.steps[0].operation.advance.total === 0.5
    && r.steps[0].operation.utility === 0.5
    && r.steps[1].operation.scan === undefined && r.steps[1].operation.advance.total === 0,
    r.steps.map(s => `${s.operation.rule}:scan=${JSON.stringify(s.operation.scan)} advance=${s.operation.advance && s.operation.advance.total}`).join('→'));
  // FS5 让位:无可执行的 hold / dig → 不出手;清单事实仍返回(可观测)
  const b5 = new Board(level(40, 24, [['X', 0, 2, 0], ['A', 0, 12, 1], ['X', 16, 2, 0], ['U', 24, 2, 0], ['V', 32, 2, 0]]));
  b5.pick(2); b5.pick(3); b5.pick(4);
  const s5 = selectDig(buildCtx(b5));
  check('dig 让位(无可执行):不出手;清单事实记 1 对、可执行 0',
    s5.match === null && digRung.decide(buildCtx(b5)) === null
    && JSON.stringify(s5.scan) === JSON.stringify({ pairs: 1, executable: 0, elements: 1 }),
    `scan=${JSON.stringify(s5.scan)}`);
  // FS6 无 hold / dig 配对:无清单事实、让位
  const s6 = selectDig(buildCtx(new Board(flatLevel())));
  check('只有 double 型(报告期已验算)→ dig 无 hold / dig 候选,让位且无清单记录',
    s6.match === null && s6.scan === undefined);
}
{
  // FS6b 角色互换不换身份(2026-11-25 报告契约):同一无序对在拾取前后角色互换、
  //   类型升级,pairId 不变——身份与角色解耦,是逐 match 差分的前提
  //   平盘 E1 = {0, 1}:launcher 0 / target 1;拿 target 1 入槽 → close(launcher 1 / target 0)
  const b = new Board(flatLevel());
  const ctx = buildCtx(b);
  const before = ctx.analysis.matches.byElement.get('E1')[0];
  check('角色互换前置:double(launcher 0, target 1),pairId [0,1]',
    before.type === 'double' && before.launcher.tileId === 0 && before.target.tileId === 1
    && JSON.stringify(before.pairId) === '[0,1]',
    JSON.stringify(before.pairId));
  const after = simulateAnalysisAfterPick(1, ctx);
  const entry = after.matches.byElement.get('E1')[0];
  check('角色互换:拿 target 入槽后同一条配对 → close(launcher 1, target 0),pairId 仍 [0,1]',
    entry.type === 'close' && entry.launcher.tileId === 1 && entry.target.tileId === 0
    && JSON.stringify(entry.pairId) === '[0,1]',
    `type=${entry.type} L${entry.launcher.tileId}/T${entry.target.tileId} pairId=${JSON.stringify(entry.pairId)}`);
}
{
  // FS7 「报告说做不了,换一对做得动」在全量清单下的形态:报告逐条验算,做得了的那条直接可选
  //   槽:s(0)'S'。X:x1(1) 可点;x2(2) 被 p(3)、q(4) 压(各无伴);x3(5) 被 m1(6)、m2(7) 压(m1/m2 互为伴)
  //   三条配对报告期全部验算:(1,2) 峰值 4、(2,5) 峰值 5 均超空槽 3,(1,5) 峰值 3 可执行
  const b = new Board(level(72, 24, [['S', 56, 2, 0], ['X', 24, 2, 0], ['X', 8, 2, 0], ['P', 4, 12, 1], ['Q', 12, 12, 1],
    ['X', 40, 2, 0], ['M', 36, 12, 1], ['M', 44, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  const xs = ctx.analysis.matches.byElement.get('X');
  check('前置:X 的 3 条配对全部验算、按消耗升序——(1,5) 峰值 3 可执行,(1,2) 峰值 4、(2,5) dig 峰值 5 不可执行',
    xs.length === 3
    && xs.map(o => `${o.launcher.tileId},${o.target.tileId}:${o.type}:${o.matchCost}:${o.executable}`).join(' ') === '1,5:hold:3:true 1,2:hold:4:false 2,5:dig:5:false',
    JSON.stringify(xs.map(o => [o.launcher.tileId, o.target.tileId, o.type, o.matchCost, o.executable])));
  const op = digRung.decide(ctx);
  check('做得了的那条直接可选:(1,5) 峰值 3(m1/m2 进槽互配离场)→ 选它,拿 x1(1)',
    op !== null && op.action.tileId === 1
    && JSON.stringify(op.reason.match) === JSON.stringify({ elementId: 'X', type: 'hold', launcher: 1, target: 5, matchCost: 3 }),
    `pick=${op && op.action.tileId} match=${op && JSON.stringify(op.reason.match)}`);
  check('清单事实落盘:报告 3 对、可执行 1、1 个元素',
    JSON.stringify(op.reason.scan) === JSON.stringify({ pairs: 3, executable: 1, elements: 1 }),
    `scan=${op && JSON.stringify(op.reason.scan)}`);
}
{
  // FS8 性质(小批量:14 元素 5 盘,默认梯走到终局,逐个 dig 决策时刻核对):
  //   ① 报告里的 hold / dig 配对全部未验算;验算数 = 条目数,可执行数与元素数与实况一致
  //   ② 有可执行时:选中者为可执行、有计划的 hold / dig,且为独立重算的字典序最优
  //      (可执行 → 遗留最少 → 首牌差分最优 → 首牌 tileId → elementId → 启动牌 → 目标牌);
  //      落盘差分 = 选中者首牌的差分
  //   ③ 无可执行时:让位
  const els = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const key = o => o.pairId.join('|');
  const bad = [];
  let digDecisions = 0;
  for (let g = 0; g < 5; g++) {
    const board = new Board(buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed: 1000 + g }));
    for (let guard = 0; guard < 200; guard++) {
      const ctx = buildCtx(board);
      const s = selectDig(ctx);
      const todo = ctx.analysis.matches.opportunities.filter(o => o.type === 'hold' || o.type === 'dig');
      if (todo.length > 0) {
        digDecisions++;
        const where = `seed ${1000 + g} 第 ${guard} 步`;
        // ① 报告期已逐条验算;清单事实与实况一致(可执行数用幂等重算独立核对)
        if (!todo.every(o => o.cost !== undefined && o.executable !== undefined)) {
          bad.push(`${where}:报告里的 hold / dig 应全部已验算`);
        }
        const verified = verifyMatches(ctx.view, ctx.analysis, todo);
        const exec = verified.filter(o => o.executable === true && o.cost.picks.length > 0);
        if (!s.scan || s.scan.pairs !== todo.length || s.scan.executable !== exec.length
          || s.scan.elements !== new Set(todo.map(o => o.elementId)).size) {
          bad.push(`${where}:清单记录 ${JSON.stringify(s.scan)} 与实况(报告 ${todo.length} / 可执行 ${exec.length})不符`);
        }
        // ② / ③
        if (exec.length > 0) {
          // 独立重算:候选 = 各可执行配对的首牌(去重);效能最大者,平分取首牌 tileId 小者
          const firstIds = [...new Set(exec.map(o => o.cost.picks[0]))].sort((a, b) => a - b);
          const refFirst = firstIds.slice().sort((a, b) =>
            (advanceOf(b, ctx).total - advanceOf(a, ctx).total) || (a - b))[0];
          const refAdv = advanceOf(refFirst, ctx);
          if (!s.match) bad.push(`${where}:有可执行配对却让位`);
          else {
            if (s.match.executable !== true || !(s.match.type === 'hold' || s.match.type === 'dig')
              || s.match.cost.picks.length === 0) {
              bad.push(`${where}:选中者不是可执行、有计划的 hold / dig`);
            }
            const chosenFirst = s.match.cost.picks[0];
            if (chosenFirst !== refFirst) bad.push(`${where}:选中首牌 ${chosenFirst} ≠ 效能最大者 ${refFirst}`);
            // 所选配对必须是所选中首牌的某条可执行候选
            if (!exec.some(o => key(o) === key(s.match) && o.cost.picks[0] === chosenFirst)) {
              bad.push(`${where}:所选配对 ${key(s.match)} 不是首牌 ${chosenFirst} 的可执行候选`);
            }
            if (JSON.stringify(s.advance) !== JSON.stringify(refAdv)) bad.push(`${where}:落盘效能 ≠ 首牌效能`);
          }
        } else if (s.match !== null) {
          bad.push(`${where}:无可执行配对却出手`);
        }
      }
      const step = decideByLadder(defaultLadder, ctx);
      const pick = board.pick(step.action.tileId);
      if (!pick.ok) break;
      if (pick.paired) { board.eliminate(pick.paired[0], pick.paired[1]); board.compactSlots(); }
      if (board.isCleared() || (board.isSlotFull() && !board.findSlotPair())) break;
    }
  }
  check(`性质:5 盘共 ${digDecisions} 个 dig 决策时刻,报告 / 择优 / 记录三对口零违反`,
    digDecisions >= 20 && bad.length === 0, bad.slice(0, 4).join('\n       '));
}
{
  // 代表配对:所选首牌同时是多条可执行配对的首牌时,reason.match 记哪一条
  //   (2026-11-25 实现时定的规则:到配对完成拿牌数最少者;并列取元素名小者)
  //   seed 1000 开局:首牌 69 是 4 条可执行 dig 的首牌,pairPicks 分别为 7 / 4 / 9 / 4;
  //   69 的效能 0.9266(推进 13 个元素)是该局所有首牌里最大的 → dig 选它
  //   最少 4 拿的有 u13、u7 两条 → 代表取 u13 pair[63,65](数值经探针核实)
  const els14 = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const ctx = buildCtx(new Board(buildFilledLevel(LAYOUT.board, LAYOUT.tiles,
    { elements: els14, seed: 1000 })));
  const headed = ctx.analysis.matches.opportunities.filter(o =>
    (o.type === 'hold' || o.type === 'dig') && o.executable === true && o.cost.picks[0] === 69);
  const s = selectDig(ctx);
  check('前置:开局首牌 69 是 4 条可执行 dig 的首牌,pairPicks 7 / 4 / 9 / 4',
    headed.length === 4 && headed.map(o => o.cost.pairPicks).sort((a, b) => a - b).join(',') === '4,4,7,9',
    headed.map(o => `${o.elementId}:${o.cost.pairPicks}`).join(' '));
  check('代表配对:同一首牌的多条配对里取「到配对完成拿牌数最少」的一条;并列取元素名小者(u13 pair[63,65])',
    s.match !== null && s.match.cost.picks[0] === 69
    && s.match.elementId === 'u13' && JSON.stringify(s.match.pairId) === '[63,65]'
    && s.match.cost.pairPicks === 4 && Math.abs(s.advance.total - 0.9295) < 1e-3,
    `match=${s.match && `${s.match.elementId}[${s.match.pairId}] pp${s.match.cost.pairPicks}`} total=${s.advance && s.advance.total}`);
}

console.log('— 推进效能 advanceOf:拿一张牌推进了哪些挖掘路线(2026-11-25 设计者设计)—');
// value = 1 / (拿后 pairPicks + 拿前滞留 × k) × (拿前可执行 ? 1 : 0.1),k = 1;
// 相关配对 = picks 含所拿牌的 hold / dig;按元素取最优、跨元素求和;拿后配对消失(直接可配)不计。
// 各盘数值均先经探针核实(temp/ 探针,未入库),再固化。
{
  // A 滞留:遮挡者无伴,自己带进槽出不去 → 1/(1+1) = 0.5
  const b = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  b.pick(0);
  const a = advanceOf(2, buildCtx(b));
  check('A 滞留 1:拿遮挡者 → 拿后还差 1 拿,价值 1/(1+1) = 0.5',
    near(a.total, 0.5) && a.elements.length === 1 && a.elements[0].elementId === 'X'
    && a.elements[0].pairPicks === 1 && a.elements[0].residual === 1 && a.elements[0].executable === true,
    JSON.stringify(a));
}
{
  // B 无滞留:遮挡者有可点伴,清槽阶段配掉 → 1/(1+0) = 1.0
  const b = new Board(level(48, 24, [['X', 40, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1], ['A', 32, 2, 0]]));
  b.pick(0);
  const a = advanceOf(2, buildCtx(b));
  check('B 无滞留:价值 1/(1+0) = 1.0',
    near(a.total, 1) && a.elements[0].residual === 0 && a.elements[0].pairPicks === 1,
    JSON.stringify(a));
}
{
  // C 不可执行 × 0.1 + 滞留计入约束:槽内已有 4 张(空槽 n=0)——遮挡者 A 虽会滞留
  //   (residual 原始值仍记 1),但它的拿牌顺序 m=0 不满足 m<n → 不计入分母
  //   → 1/(1+0) × 0.1 = 0.1(约束前为 1/(1+1) × 0.1 = 0.05)
  const b = new Board(level(56, 24, [['X', 48, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1],
    ['U', 16, 2, 0], ['V', 24, 2, 0], ['W', 32, 2, 0]]));
  b.pick(0); b.pick(3); b.pick(4); b.pick(5);
  const ctx = buildCtx(b);
  const a = advanceOf(2, ctx);
  const hold = ctx.analysis.matches.opportunities.find(o => o.elementId === 'X');
  check('C 滞留计入约束:空槽 0 → 滞留牌(拿牌顺序 0)不计入分母,效能 1/(1+0) × 0.1 = 0.1;residual 原始值仍为 1',
    near(a.total, 0.1) && a.elements[0].executable === false && a.elements[0].residual === 1
    && ctx.analysis.matches.emptySlots === 0
    && JSON.stringify(hold.cost.residual) === '[2]'
    && hold.cost.picks.indexOf(2) === 0,
    JSON.stringify(a));
}
{
  // C2 槽内遗留牌的同类抵消(2026-11-26 设计者指示):闭包里有槽内遗留牌的同类牌时,
  //   挖开它能跟槽里那张配掉、腾回一格——有效滞留 −1(不减穿 0)
  //   槽:U1(0)、X0(1);X2@(0,10,L0) 被 C3@(0,6,L1)(单独即可压住,无伴)与 U4@(-7,14,L1) 压住
  //   → X:hold (1,2),region[3,4],picks[4,3,2],pairPicks 3,residual [3](C3 出不去;
  //     U4 与槽内 U1 配掉,不滞留)。闭包里有槽内遗留牌 U1 的同类 U4 → offset 1
  //   拿 C3:拿后差 2,有效滞留 1−1=0 → 1/2;无抵消则为 1/3
  const b = new Board(level(64, 24, [
    ['U', 24, 2, 0], ['X', 40, 2, 0], ['X', 0, 10, 0], ['C', 0, 6, 1], ['U', -7, 14, 1],
  ]));
  b.pick(0); b.pick(1);
  const ctx = buildCtx(b);
  const x = ctx.analysis.matches.opportunities.find(o => o.elementId === 'X');
  const a = advanceOf(3, ctx);
  check('C2 前置:X 的 hold 闭包 [3,4]、滞留 [3](C 无伴;U4 与槽内 U1 配掉不滞留)',
    JSON.stringify(x.cost.region) === '[3,4]' && JSON.stringify(x.cost.residual) === '[3]'
    && ctx.view.slot.map(s => s.elementId).join(',') === 'U,X',
    `region=${x.cost.region} res=${x.cost.residual}`);
  check('C2 同类抵消:闭包含槽内遗留牌 U1 的同类 U4 → offset 1,有效滞留 1−1=0,效能 1/2(无抵消为 1/3)',
    near(a.total, 0.5) && a.elements.length === 1 && a.elements[0].residual === 1
    && a.elements[0].offset === 1 && a.elements[0].pairPicks === 2 && a.elements[0].value === 0.5,
    JSON.stringify(a));
}
{
  // D 直接可配不计(记法乙):平盘 double 不在 hold / dig 里
  const a = advanceOf(0, buildCtx(new Board(level(16, 24, [['E', 0, 2, 0], ['E', 8, 2, 0]]))));
  check('D 直接可配(double):无相关 hold / dig,效能 0', a.total === 0 && a.elements.length === 0);
}
{
  // D2 类型过滤:细条遮挡者在一条 double 的闭包里,但 close / double 不参与推进效能
  //   E0(0)@(9,10,L0) 可点;X(1)@(2,2,L1) 只盖它 2.5%(闭包 {X},E0 仍可点);E2(2)@(18,10,L0) 可点
  //   → E:double pair[0,2] region[1] pp2。拿 X(1):在闭包里、非配对牌,但类型不符 → 0
  //   (若去掉类型过滤,会按 pp−1=1 记效能 1)
  const ctx = buildCtx(new Board(level(48, 24, [['E', 9, 10, 0], ['X', 2, 2, 1], ['E', 18, 10, 0]])));
  const d = ctx.analysis.matches.opportunities;
  check('D2 类型过滤:double 的闭包里有细条 X(1),但 close / double 不计 → 拿 X 效能 0',
    d.length === 1 && d[0].type === 'double' && JSON.stringify(d[0].pairId) === '[0,2]'
    && JSON.stringify(d[0].cost.region) === '[1]' && advanceOf(1, ctx).total === 0,
    `${d.map(o => `${o.type}${o.pairId}@${o.cost.region}`).join(' ')} | ${JSON.stringify(advanceOf(1, ctx))}`);
}
{
  // D3 所拿的牌是 pairId[0] 且在闭包里:同样是配对牌,不计
  //   同元素上牌 E0(0)@(0,2,L1) 盖住下牌 E1(1)@(0,10,L0) 上沿 2 行(20%:被压但可见)
  //   → E1 不可点、闭包 {E0};E0 可点 → E:hold pair[0,1] region[0] pp2
  //   拿 E0(1):它在闭包里,但它是这条配对的 pairId[0] → 0(若只排除 pairId[1] 会记 1)
  const ctx = buildCtx(new Board(level(48, 24, [['E', 0, 2, 1], ['E', 0, 10, 0]])));
  const d = ctx.analysis.matches.opportunities;
  check('D3 配对牌是 pairId[0] 也不计:同元素上牌在自己的闭包里,拿它效能 0',
    d.length === 1 && d[0].type === 'hold' && JSON.stringify(d[0].pairId) === '[0,1]'
    && JSON.stringify(d[0].cost.region) === '[0]' && advanceOf(0, ctx).total === 0,
    `${d.map(o => `${o.type}${o.pairId}@${o.cost.region}`).join(' ')} | ${JSON.stringify(advanceOf(0, ctx))}`);
}
{
  // E 按元素归并:一张纯遮挡者同时推进同元素的两条路线,只记较优的一条
  //   盘(按实际 tileId):x(0)'E' 可点;y(1)'E' 被 M(2) 压;z(3)'E' 被 N(4) 压;M'(5)'M'@L2 可点
  //     E hold (0,1):region[2] picks[0,2,1,5]     差 3、滞留 0
  //     E hold (0,3):region[4] picks[0,4,3]       差 3、滞留 1
  //     E dig  (1,3):region[2,4] picks[2,5,1,4,3] 差 5、滞留 1
  //   拿 M(2):它在 (0,1) 与 (1,3) 的闭包里、且不是配对牌 → 两条都相关:
  //     (0,1):差 3 → 2,滞留 0 → 1/2;(1,3):差 5 → 4,滞留 1 → 1/5
  //     归并只记较优的 1/2;逐条累加是 7/10;取最差是 1/5——三种实现在此可区分
  //   (0,3) 的闭包是 [4],不含 2 → 不相关
  const ctx = buildCtx(new Board(level(80, 24, [['E', 0, 2, 0], ['E', 24, 2, 0], ['M', 24, 12, 1],
    ['E', 48, 2, 0], ['N', 48, 12, 1], ['M', 40, 4, 2]])));
  const rel = ctx.analysis.matches.opportunities.filter(o => o.cost.region.indexOf(2) >= 0
    && o.type !== 'double');
  const a = advanceOf(2, ctx);
  check('E 前置:遮挡者 M(2) 在同元素两条 E 路线的闭包里,且不是它们的配对牌',
    rel.length === 2 && rel.every(o => o.elementId === 'E')
    && rel.map(o => `${o.type} ${o.pairId.join(':')} @${o.cost.region.join(',')} pp${o.cost.pairPicks}`).join(' | ')
      === 'hold 0:1 @2 pp3 | dig 1:3 @2,4 pp5',
    rel.map(o => `${o.type} ${o.pairId.join(':')} @${o.cost.region.join(',')} pp${o.cost.pairPicks}`).join(' | '));
  check('E 按元素归并:只记较优的一条(1/2)——既非逐条累加(7/10),也非取最差(1/5)',
    near(a.total, 0.5) && a.elements.length === 1 && JSON.stringify(a.elements[0].pairId) === '[0,1]'
    && a.elements[0].residual === 0 && a.elements[0].pairPicks === 2,
    `${a.total} ${JSON.stringify(a.elements)}`);
  check('E 拿配对牌不计:启动牌 x(0) 是两条 hold 的配对牌 → 效能 0(旧口径曾记 1/3)',
    advanceOf(0, ctx).total === 0);
  check('E 不在任何闭包里的牌不计:M\'(5) 出现在 3 条配对的 picks 里,但不在任何闭包里 → 效能 0',
    ctx.analysis.matches.opportunities.filter(o => o.cost.picks.indexOf(5) >= 0).length === 3
    && ctx.analysis.matches.opportunities.every(o => o.cost.region.indexOf(5) < 0)
    && advanceOf(5, ctx).total === 0);
}
{
  // F 跨元素求和:骑缝牌 M(4) 同时压着 E 伴与 F 伴的上沿 → 两条路线各 1/3,合计 2/3
  const ctx = buildCtx(new Board(level(64, 24, [['E', 0, 2, 0], ['E', 16, 2, 0], ['F', 40, 2, 0], ['F', 24, 2, 0], ['M', 20, 12, 1]])));
  const a = advanceOf(4, ctx);
  check('F 跨元素求和:E 与 F 各 1/3(拿后差 2 拿、滞留 1),合计 2/3',
    near(a.total, 2 / 3) && a.elements.map(e => e.elementId).join(',') === 'E,F',
    `${a.total} ${JSON.stringify(a.elements)}`);
}
{
  // F2 角色互换不丢配对(身份 = pairId,与 launcher / target 无关):
  //   E 两张都被压。a(0) 闭包 {P(2), M(4)} = 2 → 成本 3;b(1) 闭包 {Q(3)} = 1 → 成本 2
  //   拿前 dig:L1(成本低)/ T0。拿 M(4):a 闭包降到 1,与 b 打平 → 平分取 tileId 小者
  //   → 拿后 dig:L0 / T1(角色互换,pairId [0,1] 不变)
  //   峰值 5 > 空槽 4 → 不可执行 × 0.1;拿后差 4 拿、自己带入的滞留 3 → 1/(4+3) × 0.1
  const ctx = buildCtx(new Board(level(48, 24, [['E', 0, 2, 0], ['E', 16, 2, 0], ['P', 0, 12, 1], ['Q', 16, 12, 1], ['M', -6, 2, 1]])));
  const before = ctx.analysis.matches.opportunities.find(o => o.pairId.join(':') === '0:1');
  const after = simulateAnalysisAfterPick(4, ctx).matches.opportunities.find(o => o.pairId.join(':') === '0:1');
  check('F2 前置:拿 M 使两张配对牌获取成本打平 → 角色互换(L1/T0 → L0/T1),pairId 不变',
    before.launcher.tileId === 1 && before.target.tileId === 0
    && after.launcher.tileId === 0 && after.target.tileId === 1
    && JSON.stringify(before.pairId) === JSON.stringify(after.pairId),
    `前 L${before.launcher.tileId}/T${before.target.tileId} 后 L${after.launcher.tileId}/T${after.target.tileId}`);
  const a = advanceOf(4, ctx);
  check('F2 按身份对齐:角色互换的配对仍被计入(1/(4+3) × 0.1);按有序组 (1,0) 查会漏掉',
    near(a.total, 1 / 7 * 0.1) && a.elements.length === 1
    && JSON.stringify(a.elements[0].pairId) === '[0,1]' && a.elements[0].executable === false,
    `${a.total} ${JSON.stringify(a.elements)}`);
}
{
  // G 纯函数:多次预演后原视图 / 报告 / Board 不变
  const b = new Board(level(72, 24, [['E', 0, 2, 0], ['E', 24, 2, 0], ['P', 24, 12, 1], ['E', 48, 2, 0], ['Q', 48, 12, 1]]));
  const ctx = buildCtx(b);
  const snap = JSON.stringify(ctx.analysis.matches.opportunities.map(o => [o.pairId, o.matchCost, o.cost.picks]))
    + JSON.stringify(b.allTiles().map(t => [t.tileId, t.status]));
  for (const t of ctx.clickable) advanceOf(t.tileId, ctx);
  check('G 纯函数:多次计算后报告与真实 Board 不变',
    JSON.stringify(ctx.analysis.matches.opportunities.map(o => [o.pairId, o.matchCost, o.cost.picks]))
      + JSON.stringify(b.allTiles().map(t => [t.tileId, t.status])) === snap);
}
{
  // I 不做预演:效能只读当前报告(2026-11-26 设计者指示)。拿走一张牌让路线近了多少,
  //   由配对自己的执行计划直接读出——推进后 pairPicks = 拿前 − 1
  //   盘:槽 sX(0);b(1)'X' 被 a(2) 压。hold (0,1):picks [2,1],到配对完成差 2 拿
  const b = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  const before = JSON.stringify(ctx.analysis.matches.opportunities.map(o => [o.pairId, o.cost.pairPicks]));
  const a = advanceOf(2, ctx);
  check('I 直接计算:拿 a(2) 推进 (0,1),差 2 → 1;遮挡者无伴滞留 1 → 1/(1+1) = 0.5',
    near(a.total, 0.5) && a.elements[0].pairPicks === 1 && a.elements[0].pairId.join(',') === '0,1',
    JSON.stringify(a));
  // 若内部做了预演,会多调一次 analyze;用报告对象的同一性佐证「只读、不重算」
  check('I 直接计算:当前报告对象未被替换,数值不变',
    JSON.stringify(ctx.analysis.matches.opportunities.map(o => [o.pairId, o.cost.pairPicks])) === before);
}
{
  // J 只在清槽段、不在闭包里的牌不计:它不是这条路线要清掉的遮挡者
  //   盘:pB(4)'P' 不压牌;pA(5)'P' 压 r(6)'R';r'(7) 可点
  //   R:hold pair[6,7] region[5] picks[7,5,6,4],pairPicks 3
  //     闭包只有 [5](只有 5 压着 R 的牌);picks 末尾的 4 是配对完成后的清槽动作
  //   拿 5:在闭包里 → R 差 3 → 2 → 1/2;拿 4:不在闭包里 → 不相关,效能 0
  const ctx = buildCtx(new Board(level(56, 22, [
    ['X', 0, 2, 0], ['X', 8, 2, 0], ['Q', 16, 2, 0], ['Q', 24, 2, 0],
    ['P', 32, 2, 0], ['P', 40, 10, 1], ['R', 40, 2, 0], ['R', 48, 2, 0],
  ])));
  const r = ctx.analysis.matches.opportunities.find(o => o.elementId === 'R');
  check('J 前置:R 的闭包 [5]、picks [7,5,6,4]——4 在 picks 里但不在闭包里',
    JSON.stringify(r.cost.region) === '[5]' && JSON.stringify(r.cost.picks) === '[7,5,6,4]'
    && r.cost.picks.indexOf(4) >= 0 && r.cost.region.indexOf(4) < 0);
  check('J 不在闭包里的牌不计:拿 4 效能 0;拿 5(闭包内的遮挡者)→ 1/2',
    advanceOf(4, ctx).total === 0 && near(advanceOf(5, ctx).total, 1 / 2),
    `拿4=${JSON.stringify(advanceOf(4, ctx))} 拿5=${JSON.stringify(advanceOf(5, ctx))}`);
}
{
  // K 拿配对牌不计:所拿的牌若是某条配对的配对牌,那条配对不相关
  //   盘(按实际 tileId):E0(0) 在槽;E_b(1) 被 O(2) 压;E_a(3)@L1 压 R_a(4);R_b(5) 可点
  //     E hold (0,1) region[2];E hold (1,3) region[2];R hold (4,5) region[3]
  //   拿 3(E_a):3 是 E 两条 hold 的配对牌 → 不计;它在 R 的闭包里且不是 R 的配对牌 → 计入,
  //     R 差 3 → 2,滞留 0 → 1/2
  //   拿 2(O):普通遮挡者,在 E 两条 hold 的闭包里 → 取较优的 (0,1),差 2 → 1,滞留 1 → 1/2
  //   拿 5(R_b):它是 R 配对的配对牌(可点的启动牌)→ 效能 0
  const b = new Board(level(64, 24, [
    ['E', 0, 2, 0], ['E', 16, 2, 0], ['O', 16, 12, 1], ['E', 32, 12, 1], ['R', 32, 2, 0], ['R', 40, 2, 0],
  ]));
  b.pick(0);
  const ctx = buildCtx(b);
  const holdsOf = e => ctx.analysis.matches.opportunities.filter(o => o.elementId === e && o.type === 'hold')
    .map(o => `${o.pairId.join(':')}@${o.cost.region.join(',')}`).join(' ');
  check('K 前置:槽内有 E(0);E 两条 hold (0,1)(1,3),闭包都是 [2];R 一条 hold (4,5),闭包 [3]',
    ctx.view.slot.length === 1 && ctx.view.slot[0].elementId === 'E'
    && holdsOf('E') === '0:1@2 1:3@2' && holdsOf('R') === '4:5@3',
    `E:${holdsOf('E')} R:${holdsOf('R')}`);
  const a3 = advanceOf(3, ctx);
  check('K 拿配对牌不计:拿 3 是 E 两条 hold 的配对牌 → E 不计;它是 R 的纯遮挡者 → 只计 R,效能 1/2',
    near(a3.total, 0.5) && a3.elements.length === 1 && a3.elements[0].elementId === 'R'
    && a3.elements[0].pairId.join(',') === '4,5' && a3.elements[0].pairPicks === 2,
    JSON.stringify(a3));
  const a2 = advanceOf(2, ctx);
  check('K 纯遮挡者:拿 2 在 E 两条 hold 的闭包里且不是配对牌 → 按元素归并取较优的 (0,1),效能 1/2',
    near(a2.total, 0.5) && a2.elements.length === 1 && a2.elements[0].elementId === 'E'
    && a2.elements[0].pairId.join(',') === '0,1' && a2.elements[0].pairPicks === 1,
    JSON.stringify(a2));
  check('K 拿启动牌不计:R_b(5) 是 R 配对的可点启动牌 → 效能 0',
    advanceOf(5, ctx).total === 0, JSON.stringify(advanceOf(5, ctx)));
}
{
  // H 性质(小批量:14 元素 3 盘):每张可点牌的效能 = 按口径**独立重算**的结果
  //   口径(2026-11-26:不做预演,只读当前报告):
  //     相关配对 = 报告里闭包 region 含所拿牌、且所拿牌不是配对牌的 hold / dig
  //     计入滞留 = 拿牌顺序下标 < 当前空槽数的滞留牌(空槽耗尽后才拿的不计)
  //     有效滞留 = 计入滞留 − 槽内遗留牌同类抵消(闭包里有其同类牌的槽内遗留牌,每张 −1,
  //                不减穿 0;配对牌自己在槽内的那张是启动牌,不算遗留)
  //     价值 = 1 / (拿前 pairPicks − 1 + 有效滞留) × (可执行 ? 1 : 0.1);pairPicks − 1 ≤ 0 的不计
  //     按元素取价值最大的一条(平分取 pairId 字典序小者),跨元素求和
  //   并核对两条口径事实:闭包 ⊂ picks;闭包内的牌不会只落在清槽段
  const els = Array.from({ length: 14 }, (_, i) => ({ elementId: 'u' + (i + 1), displayName: '', color: '#fff' }));
  const bad = [];
  let checked = 0, nonzero = 0, inRegion = 0, asPairTile = 0, asBlocker = 0, offsetTotal = 0;
  let residualActiveTotal = 0, residualLateTotal = 0;
  const key = o => o.pairId.join(':');
  for (let g = 0; g < 3; g++) {
    const board = new Board(buildFilledLevel(LAYOUT.board, LAYOUT.tiles, { elements: els, seed: 1000 + g }));
    for (let guard = 0; guard < 60; guard++) {
      const ctx = buildCtx(board);
      if (ctx.clickable.length === 0 || board.isCleared()) break;
      const elemOf = new Map();
      for (const t of ctx.view.perceived) elemOf.set(t.tileId, t.elementId);
      for (const s of ctx.view.slot) elemOf.set(s.tileId, s.elementId);
      for (const c of ctx.clickable) {
        const a = advanceOf(c.tileId, ctx);
        checked++;
        if (a.total > 0) nonzero++;
        // ── 独立重算 ──
        const best = new Map();
        for (const m of ctx.analysis.matches.opportunities) {
          if (!(m.type === 'hold' || m.type === 'dig') || m.cost.region.indexOf(c.tileId) < 0) continue;
          inRegion++;
          if (m.cost.picks.indexOf(c.tileId) < 0) bad.push(`tileId ${c.tileId} 在 ${key(m)} 的闭包里却不在 picks 里`);
          if (m.pairId[0] === c.tileId || m.pairId[1] === c.tileId) { asPairTile++; continue; }
          if (m.cost.picks.indexOf(c.tileId) >= m.cost.pairPicks) bad.push(`tileId ${c.tileId} 是 ${key(m)} 的纯遮挡者却只落在清槽段`);
          asBlocker++;
          const after = m.cost.pairPicks - 1;
          if (after <= 0) continue;
          const residual = m.cost.residual.length;
          const residualActive = m.cost.residual.filter(id => {
            const order = m.cost.picks.indexOf(id);
            return order >= 0 && order < ctx.analysis.matches.emptySlots;
          }).length;
          residualActiveTotal += residualActive;
          residualLateTotal += residual - residualActive;
          const regionElems = new Set();
          for (const id of m.cost.region) {
            const e = elemOf.get(id);
            if (e !== undefined && e !== '?') regionElems.add(e);
          }
          let offset = 0;
          for (const s of ctx.view.slot) {
            if (s.elementId === '?') continue;
            if (s.tileId === m.pairId[0] || s.tileId === m.pairId[1]) continue;
            if (regionElems.has(s.elementId)) offset++;
          }
          offsetTotal += offset;
          const value = 1 / (after + Math.max(0, residualActive - offset)) * (m.executable ? 1 : 0.1);
          const cur = best.get(m.elementId);
          if (!cur || value > cur.value || (value === cur.value && key(m) < cur.key)) {
            best.set(m.elementId, { key: key(m), value, pairPicks: after, residual, offset, executable: !!m.executable });
          }
        }
        const ref = [...best.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
          .map(([elementId, e]) => ({ elementId, pairId: e.key.split(':').map(Number), pairPicks: e.pairPicks, residual: e.residual, offset: e.offset, executable: e.executable, value: e.value }));
        if (JSON.stringify(a.elements) !== JSON.stringify(ref)) {
          bad.push(`tileId ${c.tileId}:实现 ${JSON.stringify(a.elements)} ≠ 重算 ${JSON.stringify(ref)}`);
        }
        if (Math.abs(a.total - ref.reduce((s, e) => s + e.value, 0)) > 1e-12) bad.push(`tileId ${c.tileId}:total ≠ Σ`);
        const ids = a.elements.map(e => e.elementId);
        if (new Set(ids).size !== ids.length) bad.push(`元素重复:${ids}`);
      }
      const step = decideByLadder(defaultLadder, ctx);
      const pick = board.pick(step.action.tileId);
      if (!pick.ok) break;
      if (pick.paired) { board.eliminate(pick.paired[0], pick.paired[1]); board.compactSlots(); }
      if (board.isSlotFull() && !board.findSlotPair()) break;
    }
  }
  check(`性质:3 盘 ${checked} 张次候选,与独立重算逐字段一致(其中 ${nonzero} 张次有效能;闭包内 ${inRegion} 次:配对牌 ${asPairTile} 次不计、纯遮挡者 ${asBlocker} 次;同类抵消共 ${offsetTotal} 次;计入滞留 ${residualActiveTotal} 张、窗口外 ${residualLateTotal} 张)`,
    checked >= 200 && nonzero > 0 && asPairTile > 0 && asBlocker > 0 && offsetTotal > 0
    && residualActiveTotal > 0 && residualLateTotal > 0 && bad.length === 0, bad.slice(0, 2).join('\n       '));
}

console.log('— dig 排序的键序(可执行 → 遗留 → 首牌差分 → 首牌 tileId → elementId → 启动牌 → 目标牌)—');
// 手造最小对象直接钉 compareDigMatch 的键序:「遗留并列、消耗分先后、便宜的一方差分更大」
// 之类的局面难以在合成盘上摆出,排序键序以单元断言钉死。
{
  const m = (elementId, residual, matchCost, o = {}) => ({
    elementId, type: 'hold', matchCost, executable: o.exec !== false,
    cost: { residual: new Array(residual).fill(0), picks: [o.first ?? 1] },
    launcher: { tileId: o.launcher ?? 1 }, target: { tileId: o.target ?? 2 },
    d: o.d,
  });
  const first = (a, b) => (compareDigMatch(a, b, x => x.d) < 0 ? a : b).elementId;
  const D = (n, u, p) => ({ newExecutable: n, upgrades: u, peakDrop: p, detail: null });
  check('第 1 级:可执行先于不可执行(遗留与差分不论)',
    first(m('P', 0, 2, { exec: false }), m('Q', 3, 9, { d: D(0, 0, 0) })) === 'Q'
    && first(m('Q', 3, 9, { d: D(0, 0, 0) }), m('P', 0, 2, { exec: false })) === 'Q');
  check('第 2 级:遗留最少(差分不论)',
    first(m('P', 1, 9, { d: D(0, 0, 0) }), m('Q', 2, 2, { d: D(9, 9, 999) })) === 'P');
  check('第 3 级:同遗留比首牌差分(新增可执行 > 升级 > 峰值降);差分与首牌 tileId 指向不同候选时差分优先',
    first(m('P', 1, 2, { d: D(0, 1, 0), first: 5 }), m('Q', 1, 2, { d: D(0, 0, 99), first: 3 })) === 'P'
    && first(m('P', 1, 2, { d: D(0, 0, 99), first: 3 }), m('Q', 1, 2, { d: D(0, 1, 0), first: 5 })) === 'Q');
  check('决胜:差分并列 → 首牌 tileId 小者;再并列 → elementId / 启动牌 / 目标牌',
    first(m('P', 1, 2, { d: D(1, 0, 0), first: 5 }), m('Q', 1, 2, { d: D(1, 0, 0), first: 3 })) === 'Q'
    && first(m('P', 1, 2, { d: D(1, 0, 0), first: 3, launcher: 4 }), m('P', 1, 2, { d: D(1, 0, 0), first: 3, launcher: 2 })) === 'P'
    && first(m('P', 1, 2, { d: D(1, 0, 0), first: 3, target: 9 }), m('P', 1, 2, { d: D(1, 0, 0), first: 3, target: 4 })) === 'P');
}

console.log('— explore 梯:寻找新的潜在可能性(揭露量 > 自身风险)—');
// 2026-11-24 设计裁定:接手「无可执行匹配」的局面,这一拿缩不了占用,就尽可能多地买信息。
// 「可能命中槽内半张」的推断未采用;仅此一梯,空槽 1 的必败局面不单独处理。
// 盘面几何先用探针逐一核实(见 temp/ 探针,未入库),再固化。
{
  // A. 揭露量优先:槽内预置 X 半张、槽 3 张(空槽 1)→ X 为 hold 峰值 2,不可执行,dig 不收;
  //    拿 m 揭出 b(X) = closes(揭露 1.0)——explore 做了一件 dig 不收的好事;u 平牌揭 0
  //    牌:sX(0)'X' q(1)'Q' r(2)'R' → 入槽;b(3)'X'@(0,2,L0) 被 m(4)'M'@(0,10,L1) 压;u(5)'U'@(16,2,L0)
  const bA = new Board(level(64, 24, [['X', 40, 2, 0], ['Q', 48, 2, 0], ['R', 56, 2, 0], ['X', 0, 2, 0], ['M', 0, 10, 1], ['U', 16, 2, 0]]));
  bA.pick(0); bA.pick(1); bA.pick(2);
  const cA = buildCtx(bA);
  check('A 前置:空槽 1,X 为 hold、验算后峰值 2 不可执行;前三梯均让位',
    cA.analysis.matches.emptySlots === 1 && cA.analysis.matches.opportunities[0].type === 'hold'
      && cA.analysis.matches.opportunities[0].executable === false
      && slotCloseRung.decide(cA) === null && pairCompleteRung.decide(cA) === null && digRung.decide(cA) === null);
  const opA = exploreRung.decide(cA);
  check('A 揭露量优先:取揭出 closes 的 m(揭露 1.0),不取平牌 u(揭露 0)',
    opA !== null && opA.reason.rule === 'explore' && opA.action.tileId === 4
      && JSON.stringify(opA.expectation.exposes) === JSON.stringify([3])
      && opA.expectation.forecast.clickable[0].activation === 'closes');
  check('A explore 无消耗门槛:该匹配对 dig 不可执行,explore 仍可走出它的第一步',
    digRung.decide(cA) === null && opA.action.tileId === cA.analysis.matches.opportunities[0].cost.picks[0]);
  // C. 全并列:全独元素平牌 → 取 tileId 小者
  const cC = buildCtx(new Board(level(48, 14, [['U', 0, 2, 0], ['V', 8, 2, 0], ['W', 16, 2, 0], ['Y', 24, 2, 0]])));
  const opC = exploreRung.decide(cC);
  check('C 全并列 → 取 tileId 小者(拿 0)', opC !== null && opC.action.tileId === 0);
}
{
  // B. 揭露量并列、自身风险分出先后(风险键决定胜者)
  //    a(4)'A' 独元素 压 r(3)'R' 独元素 → 揭出 lone(0.2),a 高风险,tileId 更小
  //    p(6)'P' 压 s(5)'S' 独元素 → 揭出 lone(0.2);p 的伴 p2(7)'P' 可见但被 q(8) 压 → 低风险
  //    q 自身被顶层 t(9) 压住(不可点,不进候选);t 揭出 q 也是 lone(0.2) → 三者并列,由风险分出
  //    槽 3 张(空槽 1)→ P 的 hold 不可执行
  const bB = new Board(level(80, 36, [
    ['S1', 56, 2, 0], ['S2', 64, 2, 0], ['S3', 72, 2, 0],
    ['R', 0, 2, 0], ['A', 0, 10, 1],
    ['S', 16, 2, 0], ['P', 16, 10, 1],
    ['P', 32, 2, 0], ['Q', 32, 10, 1], ['T', 32, 18, 2],
  ]));
  bB.pick(0); bB.pick(1); bB.pick(2);
  const cB = buildCtx(bB);
  const reveals = cB.clickable.map(t => simulateReveal(t.tileId, cB.view, cB.analysis).activationSum);
  check('B 前置:三个候选揭露量并列(均为 0.2);前三梯让位',
    cB.clickable.map(t => t.tileId).join(',') === '4,6,9' && reveals.every(r => near(r, 0.2))
      && slotCloseRung.decide(cB) === null && pairCompleteRung.decide(cB) === null && digRung.decide(cB) === null,
    `可点 ${cB.clickable.map(t => t.tileId)} 揭露 ${reveals}`);
  const opB = exploreRung.decide(cB);
  check('B 自身风险次之:并列组里 tileId 最小的 a(4) 高风险,取低风险的 p(6)',
    opB !== null && opB.action.tileId === 6 && opB.reason.note.includes('低风险'),
    `pick=${opB && opB.action.tileId} note="${opB && opB.reason.note}"`);
  // 反向盘:s/p 与 r/a 两组在数组里对调(位置不变)→ 低风险的 p 的 tileId 变成 4,仍取它
  const bB2 = new Board(level(80, 36, [
    ['S1', 56, 2, 0], ['S2', 64, 2, 0], ['S3', 72, 2, 0],
    ['S', 16, 2, 0], ['P', 16, 10, 1],
    ['R', 0, 2, 0], ['A', 0, 10, 1],
    ['P', 32, 2, 0], ['Q', 32, 10, 1], ['T', 32, 18, 2],
  ]));
  bB2.pick(0); bB2.pick(1); bB2.pick(2);
  const opB2 = exploreRung.decide(buildCtx(bB2));
  check('B 对称盘:低风险的 p 此前 tileId 较大(6)、现在较小(4),两种排法都取它',
    opB2 !== null && opB2.action.tileId === 4 && opB2.reason.note.includes('低风险'),
    `pick=${opB2 && opB2.action.tileId}`);
}
{
  // 端到端:盘上只剩独元素平牌时,explore 接手并拿走第一张;随后槽满判负
  const r = runAgent(new Board(level(32, 14, [['U', 0, 2, 0], ['V', 8, 2, 0], ['W', 16, 2, 0], ['Y', 24, 2, 0]])),
    { seed: 7, decision: ladderPolicy() });
  check('端到端:四张互不成对的平牌 → explore 逐步拿完,4 pick 槽满判负',
    r.outcome === 'slot_full' && r.picks === 4 && r.steps.every(s => s.operation.rule === 'explore')
      && r.steps.map(s => s.chosenTile).join(',') === '0,1,2,3',
    `${r.outcome} ${r.picks} ${r.steps.map(s => s.chosenTile + ':' + s.operation.rule).join('→')}`);
  check('默认梯末位是 explore(wander 不在默认梯)',
    defaultLadder[defaultLadder.length - 1] === exploreRung && !defaultLadder.includes(wanderRung));
}

console.log('— 推进效能择优:三个择优梯各自负责的牌上比效能(2026-11-25 设计者设计)—');
// 取代此前的「拾取差分择优」。数值均先经探针核实(temp/ 探针,未入库),再固化。
{
  // pair-complete:候选 = 可执行 double 里的牌。P 的两张 pB(4)、pA(5) 拿哪张都能成对,
  //   但 pA 压着 R 的伴 r(6)——拿 pA 顺带推进 R 的 hold 路线
  //   pB(4)'P'@(32,2,L0) 不压任何牌;pA(5)'P'@(40,10,L1) 压 r(6)'R'@(40,2,L0);r'(7) 可点
  //   R:hold picks[7,5,6,4],到配对完成差 3 拿(前 3 拿 7、5、6)、无滞留;
  //     第 4 拿的 4 是配对完成**之后**的清槽动作(把带入的 P 牌 4 拿进来与 5 配掉)
  //     拿 5:R 差 3 → 2 → 1/2 = 0.5
  //     拿 4:4 在 picks 里但位于 pairPicks 之后(清槽尾巴),对「到配对完成」没有贡献 → 不计,效能 0
  //     X、Q 的 double 牌不在任何 hold / dig 路径上 → 0
  const ctx = buildCtx(new Board(level(56, 22, [
    ['X', 0, 2, 0], ['X', 8, 2, 0], ['Q', 16, 2, 0], ['Q', 24, 2, 0],
    ['P', 32, 2, 0], ['P', 40, 10, 1], ['R', 40, 2, 0], ['R', 48, 2, 0],
  ])));
  const op = decideByLadder([pairCompleteRung], ctx);
  check('pair-complete:同匹配的两张牌比效能——拿 pA(5) 把 R 的路线从差 3 推进到差 2(0.5);tileId 更大也胜出',
    op.action.tileId === 5 && near(op.reason.utility, 0.5)
    && op.reason.advance.elements.length === 1 && op.reason.advance.elements[0].elementId === 'R'
    && op.reason.advance.elements[0].pairPicks === 2 && op.reason.advance.elements[0].residual === 0
    && op.reason.runnerUp !== undefined && op.reason.runnerUp.tileId < 5 && op.reason.runnerUp.score === 0,
    `pick=${op.action.tileId} advance=${JSON.stringify(op.reason.advance)} ru=${JSON.stringify(op.reason.runnerUp)}`);
  check('清槽尾巴不计:4 在 R 的 picks 里,但位于第 pairPicks 拿之后 → 拿 4 不推进 R,效能 0(预演版曾误记 1/3)',
    advanceOf(4, ctx).total === 0 && ctx.analysis.matches.opportunities
      .filter(o => o.elementId === 'R').every(o => o.cost.picks.indexOf(4) >= o.cost.pairPicks),
    `advanceOf(4)=${JSON.stringify(advanceOf(4, ctx))}`);
  check('pair-complete:不在任何 hold / dig 路径上的候选效能为 0(X、Q 的四张 double 牌)',
    [0, 1, 2, 3].every(id => advanceOf(id, ctx).total === 0));
  check('pair-complete:拿哪张都能成对——所拿牌的可点伴(4)记入 note,消耗 2/4 格',
    op.reason.note.includes('伴 4 可点') && op.reason.note.includes('消耗 2/4 格') && op.reason.note.includes('候选 6'),
    `note="${op.reason.note}"`);
}
{
  // slot-close:候选 = close 型的目标牌。两个可闭对并存,其一顺带推进另一条路线
  //   cA(3)'A'@(0,12,L1) 压 x(4)'Z'@(0,2,L0);cB(5)'B'@(16,24,L1) 不压任何牌
  //   槽:sA(0)'A' sB(1)'B' sZ(2)'Z'
  //   Z:hold picks[3,4],到配对完成差 2 拿、无滞留。拿 cA(3):Z 拿后差 1 → 效能 1.0;拿 cB(5):0
  const b = new Board(level(32, 36, [
    ['A', 16, 2, 0], ['B', 24, 2, 0], ['Z', 16, 12, 0], ['A', 0, 12, 1], ['Z', 0, 2, 0], ['B', 16, 24, 1],
  ]));
  b.pick(0); b.pick(1); b.pick(2);
  const ctx = buildCtx(b);
  const op = decideByLadder([slotCloseRung], ctx);
  check('slot-close 择优:顺带推进另一条路线的候选胜(拿 cA → Z 的 hold 从差 2 到差 1,效能 1.0;次优 cB 为 0)',
    op.action.tileId === 3 && op.reason.utility === 1
    && op.reason.advance.elements.length === 1 && op.reason.advance.elements[0].elementId === 'Z'
    && op.reason.advance.elements[0].pairPicks === 1
    && op.reason.runnerUp && op.reason.runnerUp.tileId === 5 && op.reason.runnerUp.score === 0
    && op.reason.utility > op.reason.runnerUp.score,
    `pick=${op.action.tileId} advance=${JSON.stringify(op.reason.advance)} ru=${JSON.stringify(op.reason.runnerUp)}`);
  check('该操作预期:闭对(slotAfter 3−1 = 2)且 forecast 预演揭出的 x 为 closes',
    op.expectation.pairCompletes && op.expectation.slotAfter === 2
    && op.expectation.exposes.length === 1 && op.expectation.exposes[0] === 4
    && op.expectation.forecast.clickable[0].activation === 'closes');
  // 合并后的资源余量:拾取前空槽 1,预演闭对后为 2——可执行性按合并后的余量判定
  {
    const ctxX = buildCtx(b);
    const sim = simulateAnalysisAfterPick(3, ctxX);
    check('预演用合并后的资源余量:拾取前空槽 1 → 闭对离场后 2;后续匹配按此判定',
      ctxX.analysis.matches.emptySlots === 1 && sim.matches.emptySlots === 2
        && sim.matches.opportunities.every(o => o.executable));
  }
}

console.log('— pair-complete(拾取差分):候选来源 / 可执行门槛 / 匹配身份与角色无关 —');
{
  // 候选来源 = MatchReport 中可执行的 double 型匹配;每个匹配两张牌各预演一次
  const ctx = buildCtx(new Board(flatLevel()));
  const doubles = ctx.analysis.matches.opportunities.filter(o => o.type === 'double' && o.executable);
  const op = pairCompleteRung.decide(ctx);
  check('候选来源:平盘 4 个可执行 double(峰值均为 2 / 空槽 4)',
    doubles.length === 4 && doubles.every(o => o.matchCost === 2)
    && ctx.analysis.matches.emptySlots === 4);
  check('pair-complete 出手并携带推进效能;reason 注明消耗 2/4 格;所拿的牌属于某个 double',
    op !== null && op.reason.rule === 'pair-complete' && op.reason.advance !== undefined
      && op.reason.note.includes('消耗 2/4 格')
      && doubles.some(o => o.launcher.tileId === op.action.tileId || o.target.tileId === op.action.tileId),
    `note="${op && op.reason.note}"`);
  check('纯平盘没有 hold / dig:候选效能全为 0,按 tileId 决胜(拿 0),次优 1(0)',
    op.action.tileId === 0 && op.reason.utility === 0 && op.reason.advance.elements.length === 0
    && op.reason.runnerUp && op.reason.runnerUp.tileId === 1 && op.reason.runnerUp.score === 0,
    `pick=${op.action.tileId} ru=${JSON.stringify(op.reason.runnerUp)}`);
}
{
  // 可执行门槛:double 的峰值为 2,空槽不足 2 时匹配不可执行 → 整梯让位
  //   X(0) X(1) 双亮;U(2) V(3) W(4) 入槽
  const spec = [['X', 0, 2, 0], ['X', 8, 2, 0], ['U', 16, 2, 0], ['V', 24, 2, 0], ['W', 32, 2, 0]];
  const b1 = new Board(level(40, 14, spec));
  b1.pick(2); b1.pick(3); b1.pick(4);
  const ctx1 = buildCtx(b1);
  check('空槽 1:double 不可执行(峰值 2 > 1)→ pair-complete 让位',
    ctx1.analysis.matches.emptySlots === 1
      && ctx1.analysis.matches.opportunities.some(o => o.elementId === 'X' && o.type === 'double' && !o.executable)
      && pairCompleteRung.decide(ctx1) === null);
  const b2 = new Board(level(40, 14, spec));
  b2.pick(2); b2.pick(3);
  const op2 = pairCompleteRung.decide(buildCtx(b2));
  check('空槽 2:double 可执行 → pair-complete 出手', op2 !== null && op2.action.tileId === 0);
}
{
  // 轨迹:defaultLadder 下 pair-complete / slot-close 的操作都携带推进效能落盘,
  //   utility = 效能总量(启动梯已移除;平盘没有 hold / dig,效能全为 0)
  const r = runAgent(new Board(flatLevel()), { seed: 7, decision: ladderPolicy() });
  const picks = r.steps.filter(s => s.operation.rule === 'pair-complete' || s.operation.rule === 'slot-close');
  check('轨迹:pair-complete 与 slot-close 各步都携带 advance,utility = 效能总量',
    picks.length === 8 && picks.every(s => s.operation.advance && s.operation.utility === s.operation.advance.total));
}
// 平分确定性:对称盘 → tileId 小者。
//   pair-complete 这条同时依赖「匹配身份与角色无关」:若按 (launcher, target) 记身份,
//   拿 target 会被算成「新出现一个 close」而多得一次新增可执行,平局就不成立了
{
  const opT = decideByLadder([pairCompleteRung], buildCtx(new Board(flatLevel())));
  check('pair-complete 平分取 tileId 小者(拿 0)', opT.action.tileId === 0);
  const bT = new Board(flatLevel());
  bT.pick(0); bT.pick(2);
  const opT2 = decideByLadder([slotCloseRung], buildCtx(bT));
  check('slot-close 平分取 tileId 小者(拿 1)', opT2.action.tileId === 1);
}
{
  // 轨迹携带:expectation.forecast 随每步落盘,exposes 与其一致
  const run = runAgent(new Board(level(24, 28, [
    ['A', 16, 2, 0], ['A', 0, 2, 0], ['B', 0, 16, 0], ['M', 0, 12, 1],
  ])), { seed: 7, decision: ladderPolicy() });
  check('轨迹 expectation 携带 forecast,exposes = forecast.clickable 的 tileId',
    run.steps.length > 0 && run.steps.every(s => s.operation.expectation.forecast
      && JSON.stringify(s.operation.expectation.exposes)
        === JSON.stringify(s.operation.expectation.forecast.clickable.map(c => c.tileId))));
}

console.log('— MatchReport 配对保留扩展(2026-11-24):全部候选参与择优 / 按牌去重 / 按元素归并 —');
{
  // 择优不受候选假值影响:择优梯直接拿 tileId 当候选,数值 0 也是合法候选
  //   X0(0,6,L1) 盖住 Y_a(2)@(0,10,L0) 上沿;X1(1)@(8,10);Y_b(3)@(16,10)
  //   Y:hold picks[3,0,2,1](到配对完成差 3 拿、无滞留)——X 的两张牌都在这条路线里
  //     Y:hold picks[3,0,2,1],到配对完成差 3 拿(前 3 拿 3、0、2);第 4 拿的 1 是清槽动作
  //     拿 X0(0):0 在到配对完成的路径上,Y 差 3 → 2 → 1/2 = 0.5
  //     拿 X1(1):1 在 picks 里但位于 pairPicks 之后(清槽尾巴)→ 不计,效能 0
  const ctx = buildCtx(new Board(level(40, 20, [
    ['X', 0, 6, 1], ['X', 8, 10, 0], ['Y', 0, 10, 0], ['Y', 16, 10, 0]])));
  const a0 = advanceOf(0, ctx);
  const a1 = advanceOf(1, ctx);
  check('前置:拿 tileId 0 的效能 0.5(推进 Y 的 hold 路线);拿 tileId 1 效能 0(清槽尾巴,不计)',
    near(a0.total, 0.5) && a0.elements[0].elementId === 'Y' && a0.elements[0].pairPicks === 2
    && a1.total === 0 && a1.elements.length === 0,
    `拿0:${a0.total} 拿1:${a1.total}`);
  const op = pairCompleteRung.decide(ctx);
  check('择优:候选是数值 tileId(含 0)时也能正常胜出(拿 0),次优 = 1(效能 0)',
    op.action.tileId === 0 && op.reason.runnerUp !== undefined
    && op.reason.runnerUp.tileId === 1 && op.reason.runnerUp.score === 0
    && op.reason.utility === a0.total,
    `拿 ${op.action.tileId} · 次优 ${op.reason.runnerUp?.tileId} · note="${op.reason.note}"`);
}
{
  // slot-close:槽内一张牌有多张可点的伴时,全部参与择优(此前每元素只留获取成本最低的一条)
  //   槽内 S(tileId 0);Z1(1) 是平牌;Z2(4,L1) 压着 Y_a(2) 的上沿;Y_b(3) 可点
  //   拿 Z2 才会让 Y 的配对 hold → double;两者平分时 tileId 小的 Z1 会赢,所以必须 Z2 严格更优
  const b = new Board(level(60, 24, [
    ['e1', 0, 10, 0], ['e1', 9, 10, 0], ['Y', 18, 10, 0], ['Y', 27, 10, 0], ['e1', 18, 4, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  const closes = ctx.analysis.matches.opportunities.filter(o => o.type === 'close');
  check('slot-close 候选:close 型 2 条,启动牌都是槽内那张,目标分别是 1 与 4',
    closes.length === 2 && closes.every(o => o.launcher.inSlot && o.launcher.tileId === 0)
    && closes.map(o => o.target.tileId).join(',') === '1,4',
    closes.map(o => `${o.launcher.tileId}→${o.target.tileId}`).join(' '));
  const op = slotCloseRung.decide(ctx);
  check('slot-close 拿差分更优的那张(tileId 4),不再只看获取成本最低的一条;reason 注明候选 2 张',
    op.action.tileId === 4 && op.reason.note.includes('候选 2')
    && op.reason.runnerUp !== undefined && op.reason.runnerUp.tileId === 1,
    `拿 ${op.action.tileId} · note="${op.reason.note}"`);
}
{
  // pair-complete:同元素三张可点 → 三条 double 配对(六个人选),按牌去重后只预演三张
  //   A0(0,2) A1(8,2) A2(24,4,L1);A2 压着 Y_a(24,10) 的上沿;Y_b(40,10) 可点
  const ctx = buildCtx(new Board(level(56, 20, [
    ['A', 0, 2, 0], ['A', 8, 2, 0], ['Y', 40, 10, 0], ['Y', 24, 10, 0], ['A', 24, 4, 1]])));
  const doubles = ctx.analysis.matches.opportunities.filter(o => o.type === 'double');
  check('pair-complete 候选:3 条 double 配对;按牌去重后候选 3 张(不是 6)',
    doubles.length === 3 && pairCompleteRung.decide(ctx) !== null
    && pairCompleteRung.decide(ctx).reason.note.includes('候选 3'),
    `double ${doubles.length} 条 · note="${pairCompleteRung.decide(ctx)?.reason.note}"`);
  const op = pairCompleteRung.decide(ctx);
  check('pair-complete 拿三张里差分最优的 tileId 4,并列出它的两个可点伴(0 / 1)',
    op.action.tileId === 4 && op.reason.note.includes('伴 0/1 可点'),
    `拿 ${op.action.tileId} · note="${op.reason.note}"`);
}
{
  // 差分按元素计:同一元素一次多出两条可执行配对,不重复计数
  //   X0(0,6,L1) 压着 Y_a(1) 的上沿;Y_b(2) Y_c(3) 可点 → 拿 X0 后 Y 名下从 1 条 double 变 3 条
  const ctx = buildCtx(new Board(level(40, 20, [
    ['X', 0, 6, 1], ['Y', 0, 10, 0], ['Y', 16, 10, 0], ['Y', 24, 10, 0]])));
  const after = simulateAnalysisAfterPick(0, ctx);
  const d = pickDelta(0, ctx);
  const beforeY = ctx.analysis.matches.byElement.get('Y') ?? [];
  const afterY = after.matches.byElement.get('Y') ?? [];
  check('前置:全量清单下 Y 名下拿前 3 条(1 double + 2 hold,均已验算、可执行),拿后 3 条 double(可执行)',
    beforeY.length === 3 && beforeY.filter(o => o.type === 'double').length === 1
    && beforeY.filter(o => o.type === 'hold').length === 2
    && beforeY.every(o => o.cost !== undefined && o.executable === true)
    && afterY.length === 3 && afterY.every(o => o.type === 'double' && o.executable === true),
    `前 ${beforeY.length} 条(double ${beforeY.filter(o => o.type === 'double').length})`
      + ` · 后 ${afterY.length} 条`);
  check('按元素计:Y 原本就可执行、等级不变、最低消耗不变 → 差分 0/0/0(按配对会记成 2/2/0)',
    d.newExecutable === 0 && d.upgrades === 0 && d.peakDrop === 0
    && d.detail.appeared.length === 0 && d.detail.upgraded.length === 0,
    JSON.stringify(d));
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
