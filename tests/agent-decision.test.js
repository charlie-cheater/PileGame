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
const { decideByLadder, ladderPolicy, slotCloseRung, pairCompleteRung, chainRung, wanderRung,
  defaultLadder, scorePick } = require('../temp/v3check/agent/Ladder');
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

console.log('— 优先级实证:slot-close 须先于 pair-complete(防半张占槽) —');
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

  // 行为实证:pair-complete 优先会连续持半占满 4 槽判负;slot-close 优先清盘
  const rBad = runAgent(new Board(board), { seed: 7,
    decision: ladderPolicy([pairCompleteRung, slotCloseRung, wanderRung]) });
  check('逆序梯(pairComplete 先)平盘 4 pick 槽满判负',
    rBad.outcome === 'slot_full' && rBad.picks === 4, `outcome=${rBad.outcome} picks=${rBad.picks}`);
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
  check('scorePick = 0.7×1.2 + 0.3×0 = 0.84', near(scorePick(3, ctx).score, 0.84),
    `score=${scorePick(3, ctx).score}`);

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
  check('scorePick = 0.7×0 + 0.3×1 = 0.3', near(scorePick(2, ctxN).score, 0.3));

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

console.log('— chain 梯:借槽两步闭合(slot / pair 两类)—');
{
  // C1 chain-slot:槽内有 X 半张;a(2) 揭出的 b(1) 是 X → 下一步拿 b 即闭
  //   sX(0)'X'@(16,2,L0) 入槽;b(1)'X'@(0,2,L0) 仅被 a(2)'A'@(0,12,L1) 压(16)
  const b = new Board(level(24, 24, [['X', 16, 2, 0], ['X', 0, 2, 0], ['A', 0, 12, 1]]));
  b.pick(0);
  const ctx = buildCtx(b);
  check('前置:前两梯让位(槽内 X 的伴被压;无同元素双亮)',
    slotCloseRung.decide(ctx) === null && pairCompleteRung.decide(ctx) === null);
  const f = simulateReveal(2, ctx.view, ctx.analysis);
  check('预演分类 slot:揭出的 b 判 closes 且 chain = slot(与槽内半张闭合)',
    f.clickable.length === 1 && f.clickable[0].tileId === 1
    && f.clickable[0].activation === 'closes' && f.clickable[0].chain === 'slot');
  const op = chainRung.decide(ctx);
  check('chain-slot:拿 a,记录链路 {b, slot},效能 0.7',
    op !== null && op.reason.rule === 'chain' && op.action.tileId === 2
    && JSON.stringify(op.reason.chain) === JSON.stringify([{ tileId: 1, kind: 'slot' }])
    && near(op.reason.utility, 0.7));
  check('chain-slot 预期:本次不闭对 / slotAfter 2 / exposes [b] / likely',
    op.expectation.pairCompletes === false && op.expectation.slotAfter === 2
    && JSON.stringify(op.expectation.exposes) === JSON.stringify([1])
    && op.expectation.confidence === 'likely');
}
{
  // C2 chain-pair:无槽;a(1) 与它揭出的 b(0) 同元素 Y → b 下一步与 a 闭合
  //   (修正前 b 被判 lone:预演曾把「刚拿的牌」当作从游戏中消失)
  const ctx = buildCtx(new Board(level(16, 24, [['Y', 0, 2, 0], ['Y', 0, 12, 1]])));
  const f = simulateReveal(1, ctx.view, ctx.analysis);
  check('预演分类 pair:揭出的同元素 b 判 closes 且 chain = pair(与本次拿的这张闭合)',
    f.clickable.length === 1 && f.clickable[0].activation === 'closes'
    && f.clickable[0].chain === 'pair' && near(f.activationSum, 1.0));
  const op = chainRung.decide(ctx);
  check('chain-pair:拿 a,记录链路 {b, pair},效能 0.7 + pair 加分 0.3 = 1.0',
    op !== null && op.action.tileId === 1 && near(op.reason.utility, 1.0)
    && JSON.stringify(op.reason.chain) === JSON.stringify([{ tileId: 0, kind: 'pair' }]));
}
{
  // C3 可用性是开关:空槽 = 1 时整梯让位(拿 a 即满槽,揭出的伴进不来);空槽 = 2 时可用
  //   b(0)'X'@(0,2,L0) 仅被 a(1)'A'@(0,12,L1) 压;槽内 X / U(/ V)
  const spec = [['X', 0, 2, 0], ['A', 0, 12, 1], ['X', 16, 2, 0], ['U', 24, 2, 0], ['V', 32, 2, 0]];
  const b1 = new Board(level(40, 24, spec));
  b1.pick(2); b1.pick(3); b1.pick(4);
  check('空槽 1:chain 让位(尽管预演能揭出槽内 X 的伴)', chainRung.decide(buildCtx(b1)) === null);
  const b2 = new Board(level(40, 24, spec));
  b2.pick(2); b2.pick(3);
  const op2 = chainRung.decide(buildCtx(b2));
  check('空槽 2:chain 可用', op2 !== null && op2.action.tileId === 1);
}
{
  // C4 两类并存:同梯按效能取最大;同分取 tileId 小者
  //   左:aP(1)'Y'@(0,12,L1) 揭 bP(0)'Y' → pair
  //   右:aS(4)'A'@(16,12,L1) 揭 bS(2)'X'(槽内有 X)→ slot,另揭 bL(3)'L'(无伴 → lone)
  //   槽:sX(5)'X'@(32,2,L0)
  const b = new Board(level(40, 28, [['Y', 0, 2, 0], ['Y', 0, 12, 1], ['X', 16, 2, 0],
    ['L', 16, 16, 0], ['A', 16, 12, 1], ['X', 32, 2, 0]]));
  b.pick(5);
  const op = chainRung.decide(buildCtx(b));
  check('槽位干净优先:pair 链(1.0)胜 slot 链多揭 1 张散牌(0.84)',
    op.action.tileId === 1 && near(op.reason.utility, 1.0)
    && JSON.stringify(op.reason.chain) === JSON.stringify([{ tileId: 0, kind: 'pair' }])
    && op.reason.runnerUp && op.reason.runnerUp.tileId === 4 && near(op.reason.runnerUp.score, 0.84));
  // 揭出牌数相同的盘:位置同上但数组序对调——slot 链 aS = 1(tileId 更小),pair 链 aP = 3
  const bT = new Board(level(40, 28, [['X', 16, 2, 0], ['A', 16, 12, 1], ['Y', 0, 2, 0],
    ['Y', 0, 12, 1], ['X', 32, 2, 0]]));
  bT.pick(4);
  const opT = chainRung.decide(buildCtx(bT));
  check('揭出牌数相同时 pair 链胜出(即便 slot 链 tileId 更小):1.0 对 0.70',
    opT.action.tileId === 3 && opT.reason.chain[0].kind === 'pair' && near(opT.reason.utility, 1.0)
    && opT.reason.runnerUp && opT.reason.runnerUp.tileId === 1 && near(opT.reason.runnerUp.score, 0.7),
    `pick=${opT.action.tileId} u=${opT.reason.utility} ru=${JSON.stringify(opT.reason.runnerUp)}`);
  // 加分的上界:slot 链若多揭出一张 pairs 牌(同元素 j0 已可点),揭露优势仍胜出
  //   aP(1)'Y'@(0,12,L1) 揭 bP(0)'Y' → pair
  //   aS(4)'A'@(16,12,L1) 揭 bS(2)'X'(槽内有 X → slot)+ pP(3)'J'(j0(5) 已可点 → pairs)
  //   槽:sX(6)'X'@(32,12,L0)
  const bB = new Board(level(40, 28, [['Y', 0, 2, 0], ['Y', 0, 12, 1], ['X', 16, 2, 0],
    ['J', 16, 16, 0], ['A', 16, 12, 1], ['J', 32, 2, 0], ['X', 32, 12, 0]]));
  bB.pick(6);
  const opB = chainRung.decide(buildCtx(bB));
  check('加分上界:slot 链多揭 1 张 pairs 牌(1.26)仍胜 pair 链(1.0)',
    opB.action.tileId === 4 && near(opB.reason.utility, 1.26)
    && JSON.stringify(opB.reason.chain) === JSON.stringify([{ tileId: 2, kind: 'slot' }])
    && opB.reason.runnerUp && opB.reason.runnerUp.tileId === 1 && near(opB.reason.runnerUp.score, 1.0),
    `pick=${opB.action.tileId} u=${opB.reason.utility} ru=${JSON.stringify(opB.reason.runnerUp)}`);
}
{
  // C6 负例:揭出的牌无已知伴 → 不是 chain
  const ctx = buildCtx(new Board(level(16, 24, [['B', 0, 2, 0], ['A', 0, 12, 1]])));
  check('揭出的牌无伴(lone):chain 让位', chainRung.decide(ctx) === null);
}
{
  // 端到端(defaultLadder):chain → 下一步 slot-close 闭合
  //   C2 盘:a 入槽 → b 揭出 → slot-close 拿 b 与 a 闭合 → 清盘
  const r = runAgent(new Board(level(16, 24, [['Y', 0, 2, 0], ['Y', 0, 12, 1]])),
    { seed: 7, decision: ladderPolicy() });
  check('chain-pair 端到端:chain(pair) → slot-close 闭合,2 pick 清盘',
    r.outcome === 'cleared' && r.picks === 2 && r.pairsEliminated === 1
    && r.steps[0].operation.rule === 'chain' && r.steps[0].operation.chain[0].kind === 'pair'
    && r.steps[1].operation.rule === 'slot-close' && r.steps[1].paired === true,
    r.steps.map(s => s.operation.rule).join('→'));
  //   C5 级联(三层):a(3)'A'@(4,8,L2) 压 b(2)'X'@(0,2,L1)(24);b 全压 a2(1)'A'@(0,2,L0)
  //   槽内 sX(0)'X'。chain 拿 a → 揭 b(slot)→ slot-close 拿 b 与 sX 闭合 →
  //   a2 失去遮挡 → slot-close 拿 a2 与槽内的 a 闭合 → 清盘
  const b5 = new Board(level(24, 20, [['X', 16, 2, 0], ['A', 0, 2, 0], ['X', 0, 2, 1], ['A', 4, 8, 2]]));
  b5.pick(0);
  const r5 = runAgent(b5, { seed: 7, decision: ladderPolicy() });
  check('chain-slot 级联端到端:chain(slot) → slot-close → slot-close,3 pick 清盘',
    r5.outcome === 'cleared' && r5.picks === 3 && r5.pairsEliminated === 2
    && r5.steps.map(s => s.operation.rule).join('→') === 'chain→slot-close→slot-close'
    && r5.steps[0].operation.chain[0].kind === 'slot',
    r5.steps.map(s => s.operation.rule).join('→'));
}

console.log('— 平级择优:揭示预演两路求和(Σ激活 0.7 / Σ近点 0.3) —');
{
  // 数量效应(求和不归一):揭 3 张 pairs(3×0.8)胜揭 2 张 closes(2×1.0)
  //   左:a(0) b(1) c(2) 同元素 'R' 全 L0,仅被 m1(3)'P'@(4,10,L1) 骑缝压(16/16/32)
  //   右:e(4)'S1' f(5)'S2' 仅被 m2(6)'Q'@(24,10,L1) 压(各 16);槽内有 S1/S2 → 各 closes
  //   伴:m1'(7)'P'@(4,24,L1) m2'(8)'Q'@(24,24,L1) 均可点;s1(9) s2(10) 入槽
  const b = new Board(level(44, 36, [
    ['R', 0, 2, 0], ['R', 8, 2, 0], ['R', 0, 12, 0], ['P', 4, 10, 1],
    ['S1', 20, 2, 0], ['S2', 28, 2, 0], ['Q', 24, 10, 1], ['P', 4, 24, 1], ['Q', 24, 24, 1],
    ['S1', 36, 2, 0], ['S2', 36, 12, 0],
  ]));
  b.pick(9); b.pick(10);
  const ctx = buildCtx(b);
  check('前置:槽 2 张(S1/S2);m1/m2 及其伴均可点;a/b/c/e/f 被压',
    ctx.view.slot.length === 2 && [3, 6, 7, 8].every(id => ctx.clickable.some(t => t.tileId === id))
    && [0, 1, 2, 4, 5].every(id => !ctx.clickable.some(t => t.tileId === id)));
  const op = decideByLadder([pairCompleteRung], ctx);
  check('数量效应:揭 3 张 pairs(m1,1.68)胜揭 2 张 closes(m2,1.40)',
    op.action.tileId === 3 && near(op.reason.utility, 1.68)
    && op.reason.runnerUp && op.reason.runnerUp.tileId === 6 && near(op.reason.runnerUp.score, 1.4),
    `pick=${op.action.tileId} u=${op.reason.utility} ru=${op.reason.runnerUp?.score}`);
}
{
  // 权重比值:1 张近点(0.3)胜 1 张散牌(0.7×0.2 = 0.14)
  //   左:mA(1)'P'@(4,10,L1) 揭 u(0)'U'@(0,2,L0)(无已知伴 → lone)
  //   右:mB(5)'Q'@(24,12,L1) 之下 t(3)'T'@(24,2,L0) 仍被可点的 n(4)'N'@(20,2,L1) 压 → near
  //   伴:mA'(2)'P'@(4,24,L1) mB'(6)'Q'@(24,26,L1)
  const ctx = buildCtx(new Board(level(32, 40, [
    ['U', 0, 2, 0], ['P', 4, 10, 1], ['P', 4, 24, 1], ['T', 24, 2, 0], ['N', 20, 2, 1],
    ['Q', 24, 12, 1], ['Q', 24, 26, 1],
  ])));
  const op = decideByLadder([pairCompleteRung], ctx);
  check('权重比值:1 张近点(mB,0.30)胜 1 张散牌(mA,0.14)',
    op.action.tileId === 5 && near(op.reason.utility, 0.3)
    && op.reason.runnerUp && op.reason.runnerUp.tileId === 1 && near(op.reason.runnerUp.score, 0.14),
    `pick=${op.action.tileId} u=${op.reason.utility} ru=${op.reason.runnerUp?.score}`);
}
{
  // slot-close 择优:两个可闭对并存,其一顺带揭出一张「又能闭」的牌
  //   cA(3)'A'@(0,12,L1) 压 x(4)'Z'@(0,2,L0)(16);cB(5)'B'@(16,24,L1) 不压任何牌
  //   槽:sA(0)'A' sB(1)'B' sZ(2)'Z'(均 @(16..32, 2..22) L0,互不重叠)
  const b = new Board(level(32, 36, [
    ['A', 16, 2, 0], ['B', 24, 2, 0], ['Z', 16, 12, 0], ['A', 0, 12, 1], ['Z', 0, 2, 0], ['B', 16, 24, 1],
  ]));
  b.pick(0); b.pick(1); b.pick(2);
  const ctx = buildCtx(b);
  const op = decideByLadder([slotCloseRung], ctx);
  check('slot-close 择优:闭对同时揭出一张 closes 的候选胜(cA,0.70;次优 cB,0)',
    op.action.tileId === 3 && near(op.reason.utility, 0.7)
    && op.reason.runnerUp && op.reason.runnerUp.tileId === 5 && op.reason.runnerUp.score === 0,
    `pick=${op.action.tileId} u=${op.reason.utility} ru=${op.reason.runnerUp?.score}`);
  check('该操作预期:闭对(slotAfter 3−1 = 2)且 forecast 预演揭出的 x 为 closes',
    op.expectation.pairCompletes && op.expectation.slotAfter === 2
    && op.expectation.exposes.length === 1 && op.expectation.exposes[0] === 4
    && op.expectation.forecast.clickable[0].activation === 'closes');
}
// 平分确定性:对称盘 → tileId 小者(两梯各验一次)
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

console.log(`\n结果:${pass} 通过,${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
