// ============================================================================
// GameController.ts — 游戏编排器:初始化 + 主循环(事件驱动)+ 胜负流程
//
// 主循环(点击驱动):
//   点击可点牌 → Board.pick → 贝塞尔飞入槽位
//     ├─ 成对 → 吸引靠拢爆闪 → eliminate → 槽位紧凑滑移 → 判胜
//     └─ 无对 → 槽满且无可配对 → 判负
//   动画期间输入加锁(locked),回调链解锁
// 关卡:饼/条/万 27 种牌型 × 1 对 = 54 张(5×5×4 金字塔,seed 42)
// 注:当前印花为全图对(混式难度 FULL 形态);二分半图待正式素材管线
// ============================================================================

import { _decorator, Component, Node, UITransform, Graphics, Label, Color } from 'cc';
import { Board } from '../core/Board';
import { buildLevel, LevelSpec } from '../core/LevelBuilder';
import { ElementDef } from '../core/tile';
import { PileView } from '../view/PileView';
import { TrayView } from '../view/TrayView';

const { ccclass } = _decorator;

const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const PALETTE = ['#E8543F', '#3D7EA6', '#4C8C4A', '#7B52A1', '#D9822B', '#C2527A'];

/** 27 种牌型:饼 1-9 / 条 1-9 / 万 1-9(风箭留后续关卡) */
function buildElements(): ElementDef[] {
  const out: ElementDef[] = [];
  const push = (suits: Array<[string, string]>) => {
    for (const [kind, name] of suits) {
      out.push({
        elementId: kind,
        displayName: name,
        color: PALETTE[out.length % PALETTE.length],
      });
    }
  };
  const nts: Array<[string, string]> = [];
  for (let n = 1; n <= 9; n++) {
    nts.push([`dot${n}`, `${CN_NUM[n]}饼`]);
  }
  for (let n = 1; n <= 9; n++) {
    nts.push([`bam${n}`, `${CN_NUM[n]}条`]);
  }
  for (let n = 1; n <= 9; n++) {
    nts.push([`wan${n}`, `${CN_NUM[n]}万`]);
  }
  push(nts);
  return out;
}

@ccclass('GameController')
export class GameController extends Component {

  private board!: Board;
  private pile!: PileView;
  private tray: TrayView | null = null;
  private locked = false;
  private overlay: Node | null = null;

  protected start(): void {
    this.pile = this.getComponent(PileView)!;
    const trayNode = this.node.parent?.getChildByName('TrayRoot');
    this.tray = trayNode?.getComponent(TrayView) ?? null;
    this.newGame();
  }

  // ─────────────────────────── 初始化 / 重开 ───────────────────────────

  private newGame(): void {
    const spec: LevelSpec = {
      pattern: { kind: 'pyramid', cols: 5, rows: 5, layers: 4 },
      elements: buildElements(),
      pairsPerElement: 1,
      seed: 42,
    };
    const level = buildLevel(spec);
    this.board = new Board(level);
    this.pile.unitPx = 15;   // TILE 8×10 后,维持牌面 120×150px 视觉
    this.pile.setup(this.board, spec.elements);
    this.pile.onTileClicked = id => this.onTileClicked(id);
    this.locked = false;
    this.dismissOverlay();
  }

  // ─────────────────────────── 主循环 ───────────────────────────

  private onTileClicked(tileId: number): void {
    if (this.locked || !this.tray) return;
    const r = this.board.pick(tileId);
    if (!r.ok) return;

    // 立即同步视图:被解除遮挡的下层牌翻面,入槽牌转正面态
    // (refresh 不触碰槽内牌位置,飞行动画不受影响)
    this.pile.refresh();

    const slotIdx = this.board.getTile(tileId)!.slotIndex ?? 0;
    this.locked = true;
    this.pile.flyToSlot(tileId, this.tray.slotWorldPos(slotIdx), () => {
      if (r.paired) {
        this.resolvePair(r.paired, () => {
          this.locked = false;
          if (this.board.isCleared()) this.showOverlay('清空成功!\n点击任意处重来');
        });
        return;
      }
      this.locked = false;
      if (this.board.isSlotFull() && !this.board.findSlotPair()) {
        this.showOverlay('槽位已满\n点击任意处重试');
      }
    });
  }

  /** 配对结算:吸引爆闪 → 消除 → 紧凑滑移 */
  private resolvePair(pair: [number, number], done: () => void): void {
    const a = this.tileAtSlot(pair[0]);
    const b = this.tileAtSlot(pair[1]);
    if (a === undefined || b === undefined) { done(); return; }

    this.pile.attractAndBurst(a, b, () => {
      this.board.eliminate(pair[0], pair[1]);
      this.board.compactSlots();
      this.pile.refresh();
      this.slideSlots(done);
    });
  }

  /** 槽内牌滑到紧凑后的新位置 */
  private slideSlots(done: () => void): void {
    if (!this.tray) { done(); return; }
    const ts = this.board.slotTiles();
    if (ts.length === 0) { done(); return; }
    let remaining = ts.length;
    for (const t of ts) {
      this.pile.slideTo(t.tileId, this.tray.slotWorldPos(t.slotIndex ?? 0), () => {
        if (--remaining === 0) done();
      });
    }
  }

  private tileAtSlot(slotIndex: number): number | undefined {
    return this.board.allTiles().find(
      t => t.status === 'slot' && t.slotIndex === slotIndex)?.tileId;
  }

  // ─────────────────────────── 胜负遮罩 ───────────────────────────

  private showOverlay(text: string): void {
    this.dismissOverlay();
    const canvas = this.node.parent!;
    const n = new Node('ResultOverlay');
    n.layer = canvas.layer;
    n.addComponent(UITransform).setContentSize(750, 1624);
    const g = n.addComponent(Graphics);
    g.fillColor = new Color(0, 0, 0, 150);
    g.rect(-375, -812, 750, 1624);
    g.fill();

    const lblNode = new Node('Text');
    lblNode.layer = n.layer;
    lblNode.parent = n;
    const lbl = lblNode.addComponent(Label);
    lbl.string = text;
    lbl.fontSize = 68;
    lbl.lineHeight = 92;
    lbl.isBold = true;
    lbl.color = Color.fromHEX(new Color(), '#F7F2E7');
    if (this.pile.printFont) lbl.font = this.pile.printFont;

    n.parent = canvas;
    n.setSiblingIndex(canvas.children.length - 1);
    n.on(Node.EventType.TOUCH_END, () => this.newGame());
    this.overlay = n;
  }

  private dismissOverlay(): void {
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }
  }
}
