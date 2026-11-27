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

import { _decorator, Component, Node, UITransform, Graphics, Label, Color, JsonAsset, resources } from 'cc';
import { Board } from '../core/Board';
import { buildLevel, LevelSpec } from '../core/LevelBuilder';
import { buildMahjongElements } from '../core/MahjongSet';
import { solvePile } from '../core/PileSolver';
import { LevelData, TILE } from '../core/tile';
import { PileView } from '../view/PileView';
import { TrayView } from '../view/TrayView';

const { ccclass, property } = _decorator;

@ccclass('GameController')
export class GameController extends Component {

  private board!: Board;
  /** 体验测试关卡:resources/levels/ 下的资源名(不含扩展名,如 level_14_win);
   *  空 = 默认金字塔(seed 42)。编辑器 Inspector 里填,点重开即换关 */
  @property
  playLevel = '';
  /** 回放求解器见证:加载后自动求解,按固定间隔逐步演示解法(关卡需可解,不可解回落普通游玩) */
  @property
  replaySolve = false;
  /** 回放步间隔(秒);实际节奏 = max(间隔, 单手动画时长) */
  @property
  replayInterval = 1.0;
  private pile!: PileView;
  private tray: TrayView | null = null;
  private locked = false;
  private replayGen = 0;        // 回放代际令牌:startWith 递增,旧循环失配即自停
  private replayQueue: number[] = [];
  private replayTotal = 0;
  private overlay: Node | null = null;

  protected start(): void {
    this.pile = this.getComponent(PileView)!;
    const trayNode = this.node.parent?.getChildByName('TrayRoot');
    this.tray = trayNode?.getComponent(TrayView) ?? null;
    this.newGame();
     }

  // ─────────────────────────── 初始化 / 重开 ───────────────────────────

  private newGame(): void {
    const name = (this.playLevel || '').trim();
    if (name !== '') {
      resources.load('levels/' + name, JsonAsset, (err, asset) => {
        if (err || !asset) {
          console.warn('[GameController] 关卡加载失败,回退默认金字塔:', name, err);
          this.startPyramid();
          return;
        }
        this.startWith(asset.json as unknown as LevelData, true);
      });
      return;
    }
    this.startPyramid();
  }

  private startPyramid(): void {
    const spec: LevelSpec = {
      pattern: { kind: 'pyramid', cols: 5, rows: 5, layers: 4 },
      elements: buildMahjongElements(),
      pairsPerElement: 1,
      seed: 42,
    };
    this.startWith(buildLevel(spec), false);
  }

  /** 版宽对齐与单张上限(与 LayoutPreview 同口径;MAX_TILE_PX = 场景实例校准值 96,非类默认 150) */
  private static readonly DESIGN_W = 750;
  private static readonly WIDTH_MARGIN = -60;
  private static readonly MAX_TILE_PX = 96;

  /** 公共启动:Board 构建 + 视图接线 + 解锁。
   *  fitView = 关卡文件路径:按实际包围盒重定中心 + 适配缩放(与 LayoutPreview 同口径);
   *  默认金字塔传 false,沿用已校准的固定视角(15px,板中心枢轴) */
  private startWith(level: LevelData, fitView: boolean): void {
    this.replayGen++;   // 作废可能残留的旧回放循环
    this.board = new Board(level);
    if (fitView) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const t of level.tiles) {
        minX = Math.min(minX, t.gx);            minY = Math.min(minY, t.gy);
        maxX = Math.max(maxX, t.gx + TILE.w);   maxY = Math.max(maxY, t.gy + TILE.h);
      }
      const layoutW = maxX - minX, layoutH = maxY - minY;
      const unit = Math.min(
        (GameController.DESIGN_W + GameController.WIDTH_MARGIN) / layoutW,
        GameController.MAX_TILE_PX / TILE.w,
      );
      this.pile.unitPx = unit;
      this.pile.pivotX = (minX + maxX) / 2;
      this.pile.pivotY = (minY + maxY) / 2;
    } else {
      this.pile.unitPx = 15;   // TILE 8×10 后,维持牌面 120×150px 校准视觉
      this.pile.pivotX = null; // pivot 跨 setup 持久,回退时须清掉上一关的包围盒枢轴
      this.pile.pivotY = null;
    }
    this.pile.setup(this.board, level.elements);
    this.pile.onTileClicked = id => this.onUserClicked(id);
    this.locked = false;
    this.dismissOverlay();
    if (this.replaySolve) this.startReplay();
  }

  // ─────────────────────────── 求解回放 ───────────────────────────

  /** 求解当前盘并按 replayInterval 逐步演示见证 */
  private startReplay(): void {
    const gen = this.replayGen;
    const t0 = Date.now();
    const res = solvePile(
      this.board.allTiles().filter(t => t.status === 'pile'),
      { maxNodes: 2000000 });
    if (res.status !== 'solved') {
      console.warn('[GameController] 回放:求解器未给出见证(' + res.status
        + ', nodes=' + res.nodes + ', ' + (Date.now() - t0) + 'ms),回落普通游玩');
      return;
    }
    console.log('[GameController] 回放:见证 ' + res.witness.length + ' 手,nodes='
      + res.nodes + ',耗时 ' + (Date.now() - t0) + 'ms');
    this.replayQueue = res.witness.slice();
    this.replayTotal = res.witness.length;
    this.scheduleOnce(() => this.replayStep(gen), this.replayInterval);
  }

  /** 回放一步:走与玩家完全相同的点击管线;上一步动画未完则稍后重试(不丢步) */
  private replayStep(gen: number): void {
    if (gen !== this.replayGen || this.replayQueue.length === 0) return;
    if (this.locked) { this.scheduleOnce(() => this.replayStep(gen), 0.1); return; }
    const tileId = this.replayQueue.shift()!;
    // 见证外因(理论不可达:求解器保证逐步可点)→ 停回放,现场交还玩家
    if (!this.board.getDerived(tileId)?.clickable) {
      console.warn('[GameController] 回放中止:第 '
        + (this.replayTotal - this.replayQueue.length) + ' 手 tile ' + tileId + ' 不可点');
      this.replayQueue = [];
      return;
    }
    console.log('[GameController] 回放 '
      + (this.replayTotal - this.replayQueue.length) + '/' + this.replayTotal
      + ': tile ' + tileId);
    this.onTileClicked(tileId);
    this.scheduleOnce(() => this.replayStep(gen), this.replayInterval);
  }

  // ─────────────────────────── 主循环 ───────────────────────────

  /** 玩家点击入口:回放期间忽略手动点击(回放自身走 onTileClicked 直调,不经此门) */
  private onUserClicked(tileId: number): void {
    if (this.replayQueue.length > 0) return;
    this.onTileClicked(tileId);
  }

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
