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
const { perceive } = require('../temp/v3check/agent/Perception');
const { analyze, simulateReveal } = require('../temp/v3check/agent/Analysis');
const { decideByLadder, ladderPolicy, slotCloseRung, pairCompleteRung, digRung, selectDigMatch,
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
    check('边界 A:伴被压时 slot-close 让位(不收 hold 型,即便可执行);计划 = 先拿压它的 X 再拿伴',
      preOk && held.executable === true && held.cost.picks.join(',') === '4,1'
      && slotCloseRung.decide(ctxHeld) === null,
      `held.executable=${held?.executable} peak=${held?.matchCost} picks=${held?.cost.picks.join(',')} empty=${ctxHeld.analysis.matches.emptySlots}`);
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
  check('逐对交替节奏:偶数步 pair-complete / 奇数步 slot-close',
    r1.steps.every((s, i) => s.operation.rule === (i % 2 === 0 ? 'pair-complete' : 'slot-close')));

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

console.log('— dig 梯(基础数据选择):候选来源 / 排序占位 / 动作 / 门槛 / 端到端 —');
// 2026-11-24:原 chain 梯整体移除——借槽两步闭合的两类机会在 MatchReport 中均为
// 可执行的 hold 型匹配(峰值 2),由 dig 梯(除 close / double 外的可执行匹配)覆盖。
// 匹配间的排序待设计裁定,现暂取 MatchReport 既有顺序(消耗升序,同消耗按 elementId)。
{
  // DG1 候选来源:close 型、double 型、不可执行的匹配都不收
  //   槽:u0(0)'U' x0(4)'X';u(1)'U' 可点 → U 为 close;p(2) p(3)'P' → double
  //   b(5)'X' 被 a(6)'A'@(40,12,L1) 压 → X 为 hold(峰值 2,空槽 2 → 可执行)
  //   z(7) 被 n(8) 压、z'(9) 被 n'(10) 压 → Z 为 dig(峰值 4 > 2 → 不可执行)
  const b = new Board(level(80, 24, [['U', 0, 2, 0], ['U', 8, 2, 0], ['P', 16, 2, 0], ['P', 24, 2, 0],
    ['X', 32, 2, 0], ['X', 40, 2, 0], ['A', 40, 12, 1], ['Z', 56, 2, 0], ['N', 56, 12, 1],
    ['Z', 72, 2, 0], ['N2', 72, 12, 1]]));
  b.pick(0); b.pick(4);
  const ctx = buildCtx(b);
  const byType = ctx.analysis.matches.opportunities.map(o => `${o.elementId}:${o.type}:${o.executable}`).join(' ');
  check('前置:U 为 close、P 为 double、X 为 hold(可执行)、Z 为 dig(不可执行);空槽 2',
    byType === 'U:close:true P:double:true X:hold:true Z:dig:false' && ctx.analysis.matches.emptySlots === 2,
    byType);
  check('候选来源:只选出可执行的 hold / dig → 唯一候选 X',
    (selectDigMatch(ctx) || {}).elementId === 'X');
  const op = digRung.decide(ctx);
  check('dig 出手:rule = dig,reason.match 结构化记录所选匹配(X / hold / 启动 4 / 目标 5 / 消耗 2)',
    op !== null && op.reason.rule === 'dig' && op.action.tileId === 6
      && JSON.stringify(op.reason.match) === JSON.stringify({ elementId: 'X', type: 'hold', launcher: 4, target: 5, matchCost: 2 }),
    `pick=${op && op.action.tileId} match=${JSON.stringify(op && op.reason.match)}`);
  check('reason 注明消耗与空槽数、计划步数',
    op.reason.note.includes('消耗 2/2 格') && op.reason.note.includes('计划 3 步'),
    `note="${op.reason.note}"`);
}
{
  // DG2 排序(占位):暂取 MatchReport 既有顺序——消耗升序
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
  // 同遗留同消耗并列 → 按 elementId(L 与 T 遗留各 1 张、消耗同 3 格)
  const ctxT = buildCtx(new Board(level(48, 24, [['L', 0, 2, 0], ['L', 8, 2, 0], ['M', 0, 12, 1],
    ['T', 24, 2, 0], ['T', 32, 2, 0], ['N', 24, 12, 1]])));
  check('排序:同遗留同消耗并列 → 按 elementId(L 先于 T)',
    ctxT.analysis.matches.opportunities.map(o => `${o.elementId}:${o.matchCost}`).join(' ') === 'L:3 T:3'
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
    `pick=${opD && opD.action.tileId} match=${JSON.stringify(opD && opD.reason.match)}`);
}
{
  // DG4 门槛:不可执行的匹配不收(空槽 1 时 hold 峰值 2 > 1)
  const spec = [['X', 0, 2, 0], ['A', 0, 12, 1], ['X', 16, 2, 0], ['U', 24, 2, 0], ['V', 32, 2, 0]];
  const b = new Board(level(40, 24, spec));
  b.pick(2); b.pick(3); b.pick(4);
  const ctx = buildCtx(b);
  const only = ctx.analysis.matches.opportunities;
  check('空槽 1:唯一的 hold 不可执行 → dig 让位',
    ctx.analysis.matches.emptySlots === 1 && only.length === 1 && only[0].type === 'hold' && !only[0].executable
      && selectDigMatch(ctx) === null && digRung.decide(ctx) === null);
  // DG5 负例:只有 double(归 pair-complete)→ dig 让位
  const flat = buildCtx(new Board(flatLevel()));
  check('只有 double 型匹配 → dig 让位', selectDigMatch(flat) === null && digRung.decide(flat) === null);
}
{
  // DG6 端到端(defaultLadder)
  //   启动牌可点的 hold:dig 拿启动牌 → slot-close 闭合 → 清盘
  const r = runAgent(new Board(level(16, 24, [['Y', 0, 2, 0], ['Y', 0, 12, 1]])), { seed: 7, decision: ladderPolicy() });
  check('端到端·hold:dig → slot-close 闭合,2 pick 清盘',
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
  check('A 前置:空槽 1,X 为 hold 峰值 2 不可执行;前三梯均让位',
    cA.analysis.matches.emptySlots === 1 && cA.analysis.matches.opportunities[0].type === 'hold'
      && !cA.analysis.matches.opportunities[0].executable
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

console.log('— 拾取差分择优:同一匹配的两张牌差分不同(两张牌各预演一次)—');
{
  // 候选 = 可执行 double;每个匹配的两张牌各预演一次。本盘候选:P(3,7)、Q(6,8) 共四张
  //   左:a(0) b(1) c(2) 同元素 'R' 全 L0,仅被 m1(3)'P'@(4,10,L1) 骑缝压(16/16/32)
  //   右:e(4)'S1' f(5)'S2' 仅被 m2(6)'Q'@(24,10,L1) 压(各 16);槽内有 S1/S2
  //   伴:m1'(7)'P'@(4,24,L1) m2'(8)'Q'@(24,24,L1) 均可点;s1(9) s2(10) 入槽
  //   四张牌的差分(新增可执行 / 升级 / 峰值降):
  //     拿 3(m1)  [0/2/2]:揭出 a/b/c → R: dig→double;但空槽随之 2 → 1,
  //                         R 的 double(峰值 2)仍不可执行
  //     拿 7(m1') [1/1/3]:什么都不揭;但槽里多了 P 的半张——再模拟 R 的挖掘时,
  //                         m1 入槽即与手里的 7 闭对离场,R 净峰值 3 → 1,
  //                         在余下 1 个空槽内变得可执行
  //     拿 6(m2)  [0/3/3]:揭出 e/f → S1、S2 各 hold→close,Q double→close
  //     拿 8(m2') [0/1/3]:什么都不揭;同上,S1/S2 的净峰值各降 1
  //   注:[1/1/3] 体现 v4 消耗模型的既有性质——手里握着「即将要拿走的牌」的伴
  //   会降低那次挖掘的净占用峰值(原有持牌被用于配对时净占用随之下降)
  const b = new Board(level(44, 36, [
    ['R', 0, 2, 0], ['R', 8, 2, 0], ['R', 0, 12, 0], ['P', 4, 10, 1],
    ['S1', 20, 2, 0], ['S2', 28, 2, 0], ['Q', 24, 10, 1], ['P', 4, 24, 1], ['Q', 24, 24, 1],
    ['S1', 36, 2, 0], ['S2', 36, 12, 0],
  ]));
  b.pick(9); b.pick(10);
  const ctx = buildCtx(b);
  const triple = d => [d.newExecutable, d.upgrades, d.peakDrop].join('/');
  check('前置:槽 2 张(S1/S2);空槽 2;可执行 double 为 P 与 Q',
    ctx.view.slot.length === 2 && ctx.analysis.matches.emptySlots === 2
      && ctx.analysis.matches.opportunities.filter(o => o.type === 'double' && o.executable)
        .map(o => o.elementId).join(',') === 'P,Q');
  check('同一匹配的两张牌差分不同:P 的 3 → [0/2/2]、7 → [1/1/3];Q 的 6 → [0/3/3]、8 → [0/1/3]',
    [3, 7, 6, 8].map(id => triple(pickDelta(id, ctx))).join(' ') === '0/2/2 1/1/3 0/3/3 0/1/3',
    [3, 7, 6, 8].map(id => id + ':' + triple(pickDelta(id, ctx))).join(' '));
  const op = decideByLadder([pairCompleteRung], ctx);
  check('字典序择优:新增可执行优先 → 拿 m1\'(7)胜出;次优为 Q 里较优的 m2(6)',
    op.action.tileId === 7 && op.reason.delta.newExecutable === 1
      && op.reason.delta.detail.newExecIds.join(',') === 'R:dig'
      && op.reason.runnerUp && op.reason.runnerUp.tileId === 6
      && op.reason.utility > op.reason.runnerUp.score,
    `pick=${op.action.tileId} delta=${JSON.stringify(op.reason.delta)} ru=${JSON.stringify(op.reason.runnerUp)}`);
}
{
  // 择优不受 tileId 牵制:同一匹配里揭出升级的那张胜出,即便 tileId 更大
  //   pB(4)'P'@(32,2,L0) 不压任何牌;pA(5)'P'@(40,10,L1) 压 r(6)'R'@(40,2,L0)(32)
  //   r'(7)'R'@(48,2,L0) 可点 → R 为 hold 型(launcher r' / target r,峰值 3)
  //   另有平的双亮对 X(0,1)、Q(2,3)
  //   拿 pA(5) → r 变可点,R: hold→double(升级 2);拿 pB(4) → 无升级(升级 1)
  const ctx = buildCtx(new Board(level(56, 22, [
    ['X', 0, 2, 0], ['X', 8, 2, 0], ['Q', 16, 2, 0], ['Q', 24, 2, 0],
    ['P', 32, 2, 0], ['P', 40, 10, 1], ['R', 40, 2, 0], ['R', 48, 2, 0],
  ])));
  const op = decideByLadder([pairCompleteRung], ctx);
  check('两张牌各预演一次:取揭出升级的 pA(5),tileId 更大也胜出;次优 = 同匹配的另一张 pB(4)',
    op.action.tileId === 5 && op.reason.delta.upgrades === 2
      && op.reason.delta.detail.upgraded.join(',') === 'P:double→close,R:hold→double'
      && op.reason.runnerUp && op.reason.runnerUp.tileId === 4
      && op.reason.utility > op.reason.runnerUp.score,
    `pick=${op.action.tileId} delta=${JSON.stringify(op.reason.delta)} ru=${JSON.stringify(op.reason.runnerUp)}`);
}
{
  // slot-close 择优(拾取差分,2026-11-24):两个可闭对并存,其一顺带让另一匹配升级
  //   cA(3)'A'@(0,12,L1) 压 x(4)'Z'@(0,2,L0)(x 暴露 80%,被压但在感知集);
  //   cB(5)'B'@(16,24,L1) 不压任何牌
  //   槽:sA(0)'A' sB(1)'B' sZ(2)'Z'(均 @(16..32, 2..22) L0,互不重叠)
  //   拿 cA:x 变可点,而槽内有 sZ → 匹配 Z: hold→close(类型升级 +1);拿 cB:无升级
  const b = new Board(level(32, 36, [
    ['A', 16, 2, 0], ['B', 24, 2, 0], ['Z', 16, 12, 0], ['A', 0, 12, 1], ['Z', 0, 2, 0], ['B', 16, 24, 1],
  ]));
  b.pick(0); b.pick(1); b.pick(2);
  const ctx = buildCtx(b);
  const op = decideByLadder([slotCloseRung], ctx);
  check('slot-close 择优:带出类型升级的候选胜(拿 cA → Z: hold→close;次优 cB 无升级)',
    op.action.tileId === 3 && op.reason.delta !== undefined
      && op.reason.delta.newExecutable === 0 && op.reason.delta.upgrades === 1
      && op.reason.delta.detail.upgraded.join(',') === 'Z:hold→close'
      && op.reason.runnerUp && op.reason.runnerUp.tileId === 5
      && op.reason.utility > op.reason.runnerUp.score,
    `pick=${op.action.tileId} delta=${JSON.stringify(op.reason.delta)} ru=${JSON.stringify(op.reason.runnerUp)}`);
  check('该操作预期:闭对(slotAfter 3−1 = 2)且 forecast 预演揭出的 x 为 closes',
    op.expectation.pairCompletes && op.expectation.slotAfter === 2
    && op.expectation.exposes.length === 1 && op.expectation.exposes[0] === 4
    && op.expectation.forecast.clickable[0].activation === 'closes');
  check('差分明细:拿 cA 使 A:close 消失(自身闭对离场);Z 拾取前已可执行故不计「新增」',
    op.reason.delta.detail.disappeared.join(',') === 'A:close'
      && op.reason.delta.detail.newExecIds.length === 0,
    `detail=${JSON.stringify(op.reason.delta.detail)}`);
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
  check('pair-complete 出手并携带差分;reason 注明消耗 2/4 格;所拿的牌属于某个 double',
    op !== null && op.reason.rule === 'pair-complete' && op.reason.delta !== undefined
      && op.reason.note.includes('消耗 2/4 格')
      && doubles.some(o => o.launcher.tileId === op.action.tileId || o.target.tileId === op.action.tileId),
    `note="${op && op.reason.note}"`);
  check('匹配身份与角色无关:同一对的两张牌差分完全相同(拿 0 与拿 1 均 0/1/1,E1: double→close)',
    [0, 1].every(id => {
      const d = pickDelta(id, ctx);
      return d.newExecutable === 0 && d.upgrades === 1 && d.peakDrop === 1
        && d.detail.upgraded.join(',') === 'E1:double→close'
        && d.detail.appeared.length === 0 && d.detail.disappeared.length === 0;
    }), `拿 0:${JSON.stringify(pickDelta(0, ctx).detail)} 拿 1:${JSON.stringify(pickDelta(1, ctx).detail)}`);
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
  // 轨迹:defaultLadder 下 pair-complete 的操作携带差分落盘,utility = 差分标量
  const r = runAgent(new Board(flatLevel()), { seed: 7, decision: ladderPolicy() });
  const pc = r.steps.filter(s => s.operation.rule === 'pair-complete');
  check('轨迹:pair-complete 各步携带 delta,utility = deltaScore(delta)',
    pc.length === 4 && pc.every(s => s.operation.delta && s.operation.utility === deltaScore(s.operation.delta)));
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

console.log('— MatchReport 配对保留扩展(2026-11-24):全部候选参与择优 / 按牌去重 / 差分按元素计 —');
{
  // 择优不受候选假值影响:两个择优梯直接拿 tileId 当候选,数值 0 也是合法候选
  //   X0(0,6,L1) 盖住 Y_a(0,10,L0) 上沿(可见、可识别,但被压);X1(8,10);Y_b(16,10)
  //   拿 X0:Y 的配对 hold → double(升级 +1),外加 X 自己 double → close → 0/2/2
  //   拿 X1:只有 X 自己的变化 → 0/1/2
  const ctx = buildCtx(new Board(level(40, 20, [
    ['X', 0, 6, 1], ['X', 8, 10, 0], ['Y', 0, 10, 0], ['Y', 16, 10, 0]])));
  const d0 = pickDelta(0, ctx);
  const d1 = pickDelta(1, ctx);
  check('前置:拿 tileId 0 的差分严格优于拿 tileId 1(0/2/2 对 0/1/2)',
    d0.newExecutable === 0 && d0.upgrades === 2 && d0.peakDrop === 2
    && d1.newExecutable === 0 && d1.upgrades === 1 && d1.peakDrop === 2,
    `拿0:${d0.newExecutable}/${d0.upgrades}/${d0.peakDrop} 拿1:${d1.newExecutable}/${d1.upgrades}/${d1.peakDrop}`);
  const op = pairCompleteRung.decide(ctx);
  check('择优:候选是数值 tileId(含 0)时也能正常胜出(拿 0),次优 = 1',
    op.action.tileId === 0 && op.reason.runnerUp !== undefined
    && op.reason.runnerUp.tileId === 1 && op.reason.runnerUp.score === deltaScore(d1),
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
  check('前置:拿 X0 后 Y 名下 3 条 double(原 1 条)',
    (ctx.analysis.matches.byElement.get('Y') ?? []).length === 1
    && (after.matches.byElement.get('Y') ?? []).length === 3
    && (after.matches.byElement.get('Y') ?? []).every(o => o.type === 'double' && o.executable),
    `前 ${(ctx.analysis.matches.byElement.get('Y') ?? []).length} 条 · 后 ${(after.matches.byElement.get('Y') ?? []).length} 条`);
  check('按元素计:Y 原本就可执行、等级不变、最低消耗不变 → 差分 0/0/0(按配对会记成 2/2/0)',
    d.newExecutable === 0 && d.upgrades === 0 && d.peakDrop === 0
    && d.detail.appeared.length === 0 && d.detail.upgraded.length === 0,
    JSON.stringify(d));
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
