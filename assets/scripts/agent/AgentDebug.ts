// ============================================================================
// AgentDebug.ts — 仿真玩家代理 感知/分析 debug 可视化(审阅件,2026-11-22 验收)
//
// 在 PileView 之上叠加渲染代理的主观世界:
//   · 感知牌边框:绿 = 主观可点 / 红 = 主观被压(v3 等价定理:应与牌面 dim 一致)
//   · 右下角标:dN = 代理自建深度;前缀 ? = 身份未识别(识别阈值未达)
//     —— 顶部白色角标为 PileView 真值深度(showDebugDepth),对照用
//   · 隐藏牌幽灵:灰框 + 中央 ?(真值对照;代理不可知的位置)
//   · 遮挡边:感知子集内的上下关系线(橙 = 跨层,蓝 = 同层;线端圆点 = 被遮挡方)
//   · 顶部统计行:感知张数 / 身份未识别 / 边数 / maxDepth / 可点冲突(期望 0)
//
// 坐标映射复刻 PileView.refresh:unit → px(枢轴 + unitPx)。
// ============================================================================

import { Node, Graphics, Label, LabelOutline, Color, UITransform, Vec3, EventTouch } from 'cc';
import { Board } from '../core/Board';
import { TILE, ElementDef } from '../core/tile';
import { PileView } from '../view/PileView';
import { perceive, UNKNOWN_ELEMENT } from './Perception';
import { analyze } from './Analysis';

export interface AgentDebugOptions {
  /** 静态叠加层(牌边框/深度角标/遮挡关系线/隐藏幽灵/统计行)。
   *  默认关闭——审阅时仅保留"选中交互"组(两行信息 + 三层高亮) */
  showStatic?: boolean;
  /** 元素表(选中信息显示中文名;缺省显示 elementId) */
  elements?: ElementDef[];
}

/** 在 PileView 节点上挂接代理 debug 覆盖层(一次性,静态盘面审阅) */
export function attachAgentDebug(pile: PileView, board: Board, opts: AgentDebugOptions): void {
  // ── 代理管线:①感知 → ②分析(分析结果保持纯主观;真值对照由本层就地取 board)──
  const view = perceive(board);
  const result = analyze(view);
  const util = result.reveal;
  // 独占遮挡按遮挡者分组(direct 字段已移除,由 exclusivePairs 重建)
  const directOf = new Map<number, number[]>();
  for (const p of util.exclusivePairs) {
    let arr = directOf.get(p.above);
    if (!arr) { arr = []; directOf.set(p.above, arr); }
    arr.push(p.below);
  }
  const matches = result.matches;

  // ── 坐标映射(与 PileView.refresh 相同口径)──
  const bw = board.boardSize.w;
  const bh = board.boardSize.h;
  const pivotX = pile.pivotX ?? bw / 2;
  const pivotY = pile.pivotY ?? bh / 2;
  const u = pile.unitPx;
  const toPx = (gx: number, gy: number): Vec3 =>
    new Vec3((gx + TILE.w / 2 - pivotX) * u, (gy + TILE.h / 2 - pivotY) * u, 0);

  // ── 覆盖层(最后一个 child,绘于全部牌之上)──
  const overlay = new Node('AgentOverlay');
  overlay.layer = pile.node.layer;
  overlay.addComponent(UITransform);
  overlay.parent = pile.node;

  const g = overlay.addComponent(Graphics);
  g.clear();

  const mkLabel = (x: number, y: number, text: string, size: number, color: Color): Label => {
    const n = new Node('AgentLbl');
    n.layer = overlay.layer;
    n.parent = overlay;
    n.setPosition(x, y, 0);
    const lbl = n.addComponent(Label);
    lbl.string = text;
    lbl.fontSize = size;
    lbl.lineHeight = size + 2;
    lbl.isBold = true;
    lbl.color = color;
    const ol = n.addComponent(LabelOutline);
    ol.color = new Color(0, 0, 0, 255);
    ol.width = 3;
    return lbl;
  };

  // 信息行锚点:牌堆实际包围盒下缘(board 尺寸与牌位包围盒在 layoutJson
  // 分支不一致,以牌位为准)
  let minGy = Infinity;
  for (const t of board.allTiles()) {
    if (t.status === 'pile') minGy = Math.min(minGy, t.gy - TILE.sideH);
  }
  const bottomY = (minGy - pivotY) * u - 56;

  // ── 静态叠加层(可选,默认关闭)──
  if (opts.showStatic) {
    // 隐藏牌幽灵(真值对照:这些位置代理一无所知)
    const real = board.getVisibleState();
    g.lineWidth = 2;
    g.strokeColor = new Color(170, 170, 170, 120);
    for (const t of board.allTiles()) {
      if (t.status !== 'pile') continue;
      const vis = real.byTile.get(t.tileId);
      if (!vis || vis.exposedArea > 0) continue;
      const c = toPx(t.gx, t.gy);
      const w = TILE.w * u;
      const h = TILE.h * u;
      g.roundRect(c.x - w / 2 + 3, c.y - h / 2 + 3, w - 6, h - 6, 8);
      g.stroke();
      mkLabel(c.x, c.y, '?', 24, new Color(210, 210, 210, 170));
    }

    // 感知牌:边框(主观可点性)+ 右下角标(自建深度 / 识别状态)
    const CLICK = new Color(70, 200, 90, 230);
    const BLOCK = new Color(235, 85, 85, 230);
    const DEPTH_KNOWN = new Color(90, 220, 255, 255);   // 青:身份已知
    const DEPTH_MASKED = new Color(255, 170, 60, 255);  // 橙:身份未识别
    const byId = new Map(view.perceived.map(t => [t.tileId, t]));
    let maskedCount = 0;
    let clickableCount = 0;
    let conflictCount = 0;   // 主观可点性对真值(v3 等价定理,期望 0)
    for (const t of view.perceived) {
      const c = toPx(t.gx, t.gy);
      const w = TILE.w * u;
      const h = TILE.h * u;
      const d = result.derived.get(t.tileId);
      if (d?.clickable) clickableCount++;
      if (d?.clickable !== board.getDerived(t.tileId)?.clickable) conflictCount++;

      g.lineWidth = 3.5;
      g.strokeColor = d?.clickable ? CLICK : BLOCK;
      g.roundRect(c.x - w / 2 + 5, c.y - h / 2 + 5, w - 10, h - 10, 8);
      g.stroke();

      const masked = t.elementId === UNKNOWN_ELEMENT;
      if (masked) maskedCount++;
      const depth = result.depth.depth.get(t.tileId) ?? 0;
      mkLabel(c.x + w / 2 - 26, c.y - h / 2 + 24,
        (masked ? '?d' : 'd') + depth, 24, masked ? DEPTH_MASKED : DEPTH_KNOWN);
    }

    // 遮挡边(感知子集内;橙 = 跨层,蓝 = 同层,终点圆点 = 被遮挡方)
    for (const e of result.edges) {
      const a = byId.get(e.above);
      const b = byId.get(e.below);
      if (!a || !b) continue;
      const pa = toPx(a.gx, a.gy);
      const pb = toPx(b.gx, b.gy);
      const color = e.crossLayer
        ? new Color(255, 150, 60, 85)
        : new Color(90, 150, 255, 85);
      g.lineWidth = 2;
      g.strokeColor = color;
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.stroke();
      g.fillColor = color;
      g.circle(pb.x, pb.y, 4.5);
      g.fill();
    }

    // 统计行
    mkLabel(0, bottomY,
      `代理感知 ${view.perceived.length}/${view.totalPileCount} 张 · 未识别 ${maskedCount} · `
      + `可点 ${clickableCount} · 遮挡边 ${result.edges.length} · maxDepth ${result.depth.maxDepth} · `
      + `可点冲突 ${conflictCount}`,
      26, new Color(255, 240, 200, 255));
  }

  // ── 选中交互:点选任意牌,展示其揭露效能与直接遮挡对象 ──
  const selLayer = new Node('AgentSelOverlay');
  selLayer.layer = pile.node.layer;
  selLayer.addComponent(UITransform);
  selLayer.parent = pile.node;
  selLayer.setSiblingIndex(pile.node.children.length - 1);   // 置顶
  const hl = selLayer.addComponent(Graphics);

  const info = mkLabel(0, bottomY + 96, '点选任意牌查看揭露效能与匹配消耗',
    28, new Color(255, 220, 120, 255));
  const info2 = mkLabel(0, bottomY + 52, '',
    26, new Color(180, 230, 255, 255));
  const nameMap = new Map((opts.elements ?? []).map(e => [e.elementId, e.displayName]));
  const nameOf = (id: number): string => {
    const t = board.getTile(id);
    return nameMap.get(t?.elementId ?? '') ?? t?.elementId ?? '?';
  };

  const showTile = (tileId: number): void => {
    const t = board.getTile(tileId);
    hl.clear();
    info2.string = '';
    if (!t || t.status !== 'pile') {
      info.string = `tileId ${tileId}:已不在堆中`;
      return;
    }
    const isPerceived = view.perceived.some(p => p.tileId === tileId);
    const targets = directOf.get(tileId) ?? [];
    const w = TILE.w * u;
    const h = TILE.h * u;
    const c = toPx(t.gx, t.gy);

    // 选中牌:黄框;其直接遮挡对象:红框
    hl.lineWidth = 5;
    hl.strokeColor = new Color(255, 230, 90, 255);
    hl.roundRect(c.x - w / 2 + 2, c.y - h / 2 + 2, w - 4, h - 4, 8);
    hl.stroke();
    const targetNames: string[] = [];
    hl.lineWidth = 3;
    hl.strokeColor = new Color(255, 90, 90, 220);
    for (const id of targets) {
      const b = board.getTile(id);
      if (!b) continue;
      targetNames.push(`${nameOf(id)}@L${b.layer}`);
      const tc = toPx(b.gx, b.gy);
      hl.roundRect(tc.x - w / 2 + 6, tc.y - h / 2 + 6, w - 12, h - 12, 6);
      hl.stroke();
    }

    info.string = isPerceived
      ? `选中:${nameOf(tileId)} @L${t.layer} · 揭露效能 ${targets.length}`
        + ` · 直接遮挡:${targetNames.length ? targetNames.join('、') : '无'}`
        + ` · ${result.derived.get(tileId)?.clickable ? '可点' : '被压'}`
      : `选中:${nameOf(tileId)} @L${t.layer} · 代理未感知(这张牌被完全盖住)`;

    // ── 匹配消耗(选中牌视角;第二行)──
    if (!isPerceived) {
      info2.string = '代理未感知——不在匹配计算范围内';
      return;
    }
    const identified = view.exposure.get(tileId)?.identityKnown === true;
    if (!identified) {
      info2.string = '身份未识别(?)——不参与匹配计算';
      return;
    }
    const op = matches.opportunities.find(o => o.elementId === t.elementId);

    // 匹配存在时:挖掘区成员紫框;模拟结束时卡在槽里的剩余牌 橙色粗框(真正占槽的)
    if (op) {
      const inResidual = new Set(op.cost.residual);
      hl.lineWidth = 2.5;
      hl.strokeColor = new Color(190, 130, 255, 170);
      for (const id of op.cost.region) {
        if (id === tileId || inResidual.has(id)) continue;
        const b = board.getTile(id);
        if (!b) continue;
        const tc = toPx(b.gx, b.gy);
        hl.roundRect(tc.x - w / 2 + 8, tc.y - h / 2 + 8, w - 16, h - 16, 5);
        hl.stroke();
      }
      hl.lineWidth = 4;
      hl.strokeColor = new Color(255, 150, 40, 235);
      for (const id of op.cost.residual) {
        const b = board.getTile(id);
        if (!b) continue;
        const tc = toPx(b.gx, b.gy);
        hl.roundRect(tc.x - w / 2 + 4, tc.y - h / 2 + 4, w - 8, h - 8, 6);
        hl.stroke();
      }
    }

    if (!op) {
      const closureN = result.derived.get(tileId)?.clickable ? 0 : (result.closureSize.get(tileId) ?? 0);
      info2.string = `闭包 ${closureN} 张 · 无可见匹配(伴不可见)`;
      return;
    }
    const isLauncher = op.launcher.tileId === tileId;
    const isTarget = op.target.tileId === tileId;
    const partnerId = isLauncher ? op.target.tileId : isTarget ? op.launcher.tileId : null;

    // 匹配搭档高亮(青框)
    if (partnerId !== null) {
      const p = board.getTile(partnerId);
      if (p) {
        const pc = toPx(p.gx, p.gy);
        hl.lineWidth = 5;
        hl.strokeColor = new Color(80, 230, 230, 255);
        hl.roundRect(pc.x - w / 2 + 2, pc.y - h / 2 + 2, w - 4, h - 4, 8);
        hl.stroke();
      }
    }

    const role = isLauncher ? '启动牌' : isTarget ? '目标牌' : '候选外第三张';
    info.string = `选中:${nameOf(tileId)} @L${t.layer} · 揭露效能 ${targets.length}`
      + ` · 直接遮挡:${targetNames.length ? targetNames.join('、') : '无'}`
      + ` · ${result.derived.get(tileId)?.clickable ? '可点' : '被压'}`
      + ` · ${op.executable ? '✓可执行' : `✗需 ${op.matchCost - matches.emptySlots} 格`}`;
    info2.string = `匹配[${op.type}] 本牌=${role}`
      + (partnerId !== null
        ? ` · 搭档 ${nameOf(partnerId)}@L${board.getTile(partnerId)!.layer}`
        : '')
      + ` · 消耗 ${op.matchCost}/${matches.emptySlots} 格(峰值)`
      + ` · 占用 ${op.cost.occupancy.join('›')}`
      + ` · 剩 ${op.cost.residual.length} 张`
      + (op.cost.residual.length
        ? `(${op.cost.residual.map(nameOf).join('、')})` : '');
  };

  for (const child of pile.node.children) {
    const m = /^Tile_(\d+)$/.exec(child.name);
    if (!m) continue;
    const tileId = Number(m[1]);
    child.on(Node.EventType.TOUCH_END, (ev: EventTouch) => {
      ev.propagationStopped = true;
      showTile(tileId);
    });
  }
}
