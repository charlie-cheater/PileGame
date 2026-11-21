// ============================================================================
// PileView.ts — 牌堆视图:按 Board 状态渲染全部牌(表现层,零逻辑决策)
//
// 职责:
//   · 逻辑坐标(unit)→ 节点坐标(px):UnitMapping 契约的视图侧实现(默认 30px/unit)
//   · 绘制序:layer 升序 → 同层 gy 降序(后排先画,前排覆盖后排的侧边渗入,
//     与遮挡口径 v2.1 的"同层侧边由绘制顺序消化"配套)→ gx 升 → tileId
//   · 状态映射:pile+blocked → 绿背;pile+未压 → 正面(印花色=元素底色);
//              slot/eliminated → 隐藏(槽位/飞行动画归 TrayView,后续)
//   · 点击回调上抛(onTileClicked),可点性判定在逻辑层(Board)
//
// 牌节点为代码构建(Node + UITransform + MahjongTileArt),不依赖预制体绑定;
// 正式素材阶段由 ArtProvider 体系替换绘制实现,本视图结构不变。
// ============================================================================

import { _decorator, Component, Node, UITransform, EventTouch, Color, Font, Vec3, tween, Label, LabelOutline, Graphics } from 'cc';
import { Board } from '../core/Board';
import { ElementDef, TILE, UnitRect } from '../core/tile';
import { faceRectOf, totalRectOf } from '../core/Occlusion';
import { computeDepths, DepthReport } from '../core/Depth';
import { MahjongTileArt } from './MahjongTileArt';

const { ccclass, property } = _decorator;

/** 可直接作为 elementId 驱动印花的种类名 */
const PRINT_KIND_RE = /^(?:dot[1-9]|bam[1-9]|wan[1-9]|dong|nan|xi|bei|zhong|fa|blank)$/;

@ccclass('PileView')
export class PileView extends Component {

    /** 1 unit 的渲染像素(UnitMapping 契约;须满足 I6:厚度 = sideH×unitPx) */
    public unitPx = 30;

    /** 版面枢轴(unit 坐标,牌位相对它居中;null = board 几何中心)。
     *  导入手摆布局时由调用方设为实际包围盒中心。 */
    public pivotX: number | null = null;
    public pivotY: number | null = null;

    /** 文字牌字体(传入各牌的 printFont) */
    @property({ type: Font })
    public printFont: Font | null = null;

    /** 调试:在牌上显示深度值(深度 0 = 顶层可点) */
    @property
    public showDebugDepth = false;

    /** 点击回调(控制器注入);返回后由控制器驱动 Board 操作并调 refresh */
    public onTileClicked: ((tileId: number) => void) | null = null;

    private board: Board | null = null;
    private elementMap: Map<string, ElementDef> = new Map();
    private tileNodes: Map<number, Node> = new Map();
    private depthReport: DepthReport | null = null;
    private depthBadges: Map<number, Label> = new Map();

    /** 初始化:重建全部牌节点并同步一次状态 */
    public setup(board: Board, elements: ElementDef[]): void {
        this.board = board;
        this.elementMap = new Map(elements.map(e => [e.elementId, e]));
        this.depthReport = computeDepths(board.allTiles());
        this.depthBadges.clear();
        this.expBadges.clear();
        this.node.removeAllChildren();
        this.tileNodes.clear();

        for (const t of board.allTiles()) {
            const n = new Node(`Tile_${t.tileId}`);
            n.layer = this.node.layer;
            const ut = n.addComponent(UITransform);
            ut.setContentSize(TILE.w * this.unitPx, TILE.h * this.unitPx);
            n.addComponent(MahjongTileArt);
            n.parent = this.node;
            this.tileNodes.set(t.tileId, n);

            const tileId = t.tileId;
            n.on(Node.EventType.TOUCH_END, (ev: EventTouch) => {
                ev.propagationStopped = true;
                this.onTileClicked?.(tileId);
            });
        }
        this.refresh();
    }

    /** 全量同步:位置 / 层序 / 正背面 / 印花色 / 显隐(Board 变更后调用)。
     *  槽内牌仅置顶+正面化,位置由控制器/动画负责。 */
    public refresh(): void {
        const board = this.board;
        if (!board) return;

        const bw = board.boardSize.w;
        const bh = board.boardSize.h;

        // 绘制序:层升 → 同层后排(gy 大)先画 → gx 升 → tileId
        const sorted = [...board.allTiles()].sort((a, b) =>
            a.layer - b.layer
            || b.gy - a.gy
            || a.gx - b.gx
            || a.tileId - b.tileId);

        let drawIndex = 0;
        for (const t of sorted) {
            const n = this.tileNodes.get(t.tileId);
            if (!n) continue;

            if (t.status === 'eliminated') { n.active = false; this.setBadgeActive(t.tileId, false); this.hideCoverageDebug(t.tileId); continue; }
            n.active = true;
            n.setScale(1, 1, 1);

            if (t.status === 'pile') {
                const d = board.getDerived(t.tileId);
                // 面左上角 (gx,gy) → 中心 → 相对枢轴(默认 board 中心)
                const px = this.pivotX ?? bw / 2;
                const py = this.pivotY ?? bh / 2;
                const cx = (t.gx + TILE.w / 2 - px) * this.unitPx;
                const cy = (t.gy + TILE.h / 2 - py) * this.unitPx;
                n.setPosition(cx, cy, 0);
                n.setSiblingIndex(drawIndex++);
                this.applyArt(n, t, d?.blocked ?? false);
                this.updateDepthBadge(n, t.tileId);
                if (this.showDebugExposure) this.drawCoverageDebug(n, t.tileId, board);
                else this.hideCoverageDebug(t.tileId);
            }
        }

        // 槽内牌:全部顶置(槽位序),正面,位置不动
        for (const t of board.slotTiles()) {
            const n = this.tileNodes.get(t.tileId);
            if (!n) continue;
            n.setSiblingIndex(drawIndex++);
            this.applyArt(n, t, false);
            this.setBadgeActive(t.tileId, false);
            this.hideCoverageDebug(t.tileId);
        }
    }

    /** 调试:暴露区域可视化(showDebugExposure 开启时,红色 = 被上层覆盖区域) */
    @property
    public showDebugExposure = false;
    private expBadges: Map<number, Label> = new Map();

    /** 绘制 tile 的被覆盖区域(红)与暴露面积角标(橙,右上角)。
     *  覆盖区域 = 全部 z 更高 pile 牌的 totalRect ∩ face(t) 的并集,
     *  转换为牌面局部 px 坐标后经 art.debugCoverage 渲染(复用已验证管线)。 */
    private drawCoverageDebug(n: Node, tileId: number, board: Board): void {
        const t = board.getTile(tileId)!;
        const u = this.unitPx;
        const cxTile = t.gx + TILE.w / 2;
        const cyTile = t.gy + TILE.h / 2;
        const toLocal = (bx: number, by: number) => ({ x: (bx - cxTile) * u, y: (by - cyTile) * u });

        const cells: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const o of board.allTiles()) {
            if (o.tileId === tileId || o.status !== 'pile') continue;
            if (!(o.layer > t.layer)) continue;
            const tot = totalRectOf(o);
            const face = faceRectOf(t);
            const ix = Math.max(face.x, tot.x);
            const iy = Math.max(face.y, tot.y);
            const iw = Math.min(face.x + face.w, tot.x + tot.w) - ix;
            const ih = Math.min(face.y + face.h, tot.y + tot.h) - iy;
            if (iw > 0 && ih > 0) {
                const a = toLocal(ix, iy);
                cells.push({ x: a.x, y: a.y, w: iw * u, h: ih * u });
            }
        }

        const art = n.getComponent(MahjongTileArt)!;
        art.debugCoverage = cells.length ? cells : null;

        // 暴露面积角标(右上角,橙色)
        let lbl = this.expBadges.get(tileId);
        if (!lbl) {
            const bn = new Node('ExpBadge');
            bn.layer = n.layer;
            bn.parent = n;
            bn.setPosition(TILE.w * u / 2 - 20, TILE.h * u / 2 - 20, 0);
            lbl = bn.addComponent(Label);
            lbl.fontSize = 26;
            lbl.lineHeight = 28;
            lbl.isBold = true;
            lbl.color = new Color(255, 170, 60, 255);
            const ol = bn.addComponent(LabelOutline);
            ol.color = new Color(0, 0, 0, 255);
            ol.width = 3;
            this.expBadges.set(tileId, lbl);
        }
        const vis = board.getVisibleState().byTile.get(tileId);
        lbl.string = vis ? String(vis.exposedArea) : '?';
        lbl.node.active = true;
        art.draw();   // debugCoverage 需重绘才上屏(applyArt 在本函数之前已 draw 过)
    }

    private hideCoverageDebug(tileId: number): void {
        const lbl = this.expBadges.get(tileId);
        if (lbl) lbl.node.active = false;
    }

    /** 调试角标:在牌面上方显示深度值(showDebugDepth 开启时) */
    private updateDepthBadge(n: Node, tileId: number): void {
        if (!this.showDebugDepth || !this.depthReport) {
            this.setBadgeActive(tileId, false);
            return;
        }
        let lbl = this.depthBadges.get(tileId);
        if (!lbl) {
            const bn = new Node('DepthBadge');
            bn.layer = n.layer;
            bn.parent = n;
            bn.setPosition(0, TILE.h * this.unitPx / 2 - 24, 0);
            lbl = bn.addComponent(Label);
            lbl.fontSize = 30;
            lbl.lineHeight = 32;
            lbl.isBold = true;
            lbl.color = new Color(255, 255, 255, 255);
            const ol = bn.addComponent(LabelOutline);
            ol.color = new Color(0, 0, 0, 255);
            ol.width = 3;
            this.depthBadges.set(tileId, lbl);
        }
        lbl.string = String(this.depthReport.depth.get(tileId) ?? '?');
        lbl.node.active = true;
    }

    private setBadgeActive(tileId: number, active: boolean): void {
        const lbl = this.depthBadges.get(tileId);
        if (lbl) lbl.node.active = active;
    }

    /** 世界坐标 → 本地坐标 */
    public toLocal(worldPos: Vec3): Vec3 {
        return this.node.getComponent(UITransform)!.convertToNodeSpaceAR(worldPos);
    }

    /** 贝塞尔弧线飞入槽位(顶置) */
    public flyToSlot(tileId: number, worldPos: Vec3, onDone?: () => void): void {
        const n = this.tileNodes.get(tileId);
        if (!n) { onDone?.(); return; }
        n.setSiblingIndex(n.parent!.children.length - 1);
        const p0 = n.position.clone();
        const p2 = this.toLocal(worldPos);
        const p1 = new Vec3((p0.x + p2.x) / 2, Math.max(p0.y, p2.y) + 140, 0);
        const proxy = { t: 0 };
        tween(proxy)
            .to(0.3, { t: 1 }, {
                easing: 'sineInOut',
                onUpdate: () => {
                    const t = proxy.t;
                    const u = 1 - t;
                    n.setPosition(
                        u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
                        u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
                        0);
                },
                onComplete: () => { n.setPosition(p2); onDone?.(); },
            })
            .start();
    }

    /** 两半吸引靠拢 → 爆闪消除(拼合视效 v1,无开盒) */
    public attractAndBurst(aId: number, bId: number, onDone?: () => void): void {
        const na = this.tileNodes.get(aId);
        const nb = this.tileNodes.get(bId);
        if (!na || !nb) { onDone?.(); return; }
        const mid = new Vec3(
            (na.position.x + nb.position.x) / 2,
            (na.position.y + nb.position.y) / 2, 0);
        let doneCount = 0;
        const burst = (n: Node) => {
            tween(n)
                .to(0.12, { position: mid }, { easing: 'sineIn' })
                .to(0.08, { scale: new Vec3(1.3, 1.3, 1) })
                .to(0.16, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'backIn' })
                .call(() => {
                    n.active = false;
                    n.setScale(1, 1, 1);
                    if (++doneCount >= 2) onDone?.();
                })
                .start();
        };
        burst(na);
        burst(nb);
    }

    /** 槽位间滑动(紧凑化) */
    public slideTo(tileId: number, worldPos: Vec3, onDone?: () => void): void {
        const n = this.tileNodes.get(tileId);
        if (!n) { onDone?.(); return; }
        tween(n)
            .to(0.15, { position: this.toLocal(worldPos) }, { easing: 'sineOut' })
            .call(() => onDone?.())
            .start();
    }

    /** 调试开关运行时快照(属性在 Inspector 变更后,下一帧自动重渲染) */
    private dbgCache: { depth: boolean; exposure: boolean } | null = null;

    protected update(): void {
        if (!this.board) return;
        if (!this.dbgCache
            || this.dbgCache.depth !== this.showDebugDepth
            || this.dbgCache.exposure !== this.showDebugExposure) {
            this.dbgCache = { depth: this.showDebugDepth, exposure: this.showDebugExposure };
            this.refresh();
        }
    }

    /** 应用美术状态(印花/字体/可点性遮罩)。
     *  2026-11-20 视觉改版:被遮挡牌不再切绿背,展示正面 + 淡黑半透明遮罩 */
    private applyArt(n: Node, t: { elementId: string }, blocked: boolean): void {
        const art = n.getComponent(MahjongTileArt)!;
        const elem = this.elementMap.get(t.elementId);
        if (elem) art.printColor = Color.fromHEX(new Color(), elem.color);
        art.printKind = PRINT_KIND_RE.test(t.elementId) ? t.elementId : '';
        art.printFont = this.printFont;
        // I6 视觉一致:渲染厚度 = sideH × unitPx
        art.thickness = TILE.sideH * this.unitPx;
        art.showBack = false;
        art.dimmed = blocked;
        art.debugCoverage = null;   // 调试开关关闭时零残留(drawCoverageDebug 会按需重设)
        art.draw();
    }
}
