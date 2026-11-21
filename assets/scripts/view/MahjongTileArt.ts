// ============================================================================
// MahjongTileArt.ts — 测试用麻将牌造型(Graphics 绘制,占位美术)
// 逻辑尺寸由 UITransform 决定(建议 120×150,对应 TILE 4×5 unit 的 30px/unit 映射)
// 正式素材到位后,由 ArtProvider 图集实现替换,本组件仅服务测试期
// ============================================================================

import { _decorator, Component, Graphics, UITransform, Color, Node, Label, Font } from 'cc';
import { drawPrint, textPrintSpec, TextLine } from './TilePrints';
const { ccclass, property } = _decorator;

@ccclass('MahjongTileArt')
export class MahjongTileArt extends Component {

    /** 显示背面(绿背,被压牌形态) */
    @property
    public showBack = false;

    /** 压暗遮罩(正面之上叠淡黑半透明层,表示不可点击;2026-11-20 视觉改版) */
    @property
    public dimmed = false;

    /** 牌厚度(像素,2.5D 侧面高度)。当前口径:1 unit @ 30px/unit 映射 */
    @property
    public thickness = 30;

    /** 正面牌面色 */
    @property
    public faceColor = Color.fromHEX(new Color(), '#F7F2E7');

    /** 侧面色(厚度感) */
    @property
    public sideColor = Color.fromHEX(new Color(), '#CFC3AB');

    /** 背面色(绿背) */
    @property
    public backColor = Color.fromHEX(new Color(), '#2F8F63');

    /** 印花色(占位:红圈筒子) */
    @property
    public printColor = Color.fromHEX(new Color(), '#E8543F');

    /** 投影强度:内层椭圆透明度(0~255,视觉审阅校准值 72) */
    @property
    public shadowAlpha = 30;

    /** 投影扩散:椭圆半径倍率(1 = 默认面积) */
    @property
    public shadowScale = 0.9;

    /** 顶面外沿描边深度(0~1,面色向黑插值;转面折边 + 平铺隔离) */
    @property
    public edgeShade = 0.15;

    /** 印花种类:dot1~9(饼)/ bam1~9(条)/ wan1~9(万)/ dong/nan/xi/bei(风)/
     *  zhong(中)/ fa(發)/ blank(白板);空串 = printColor 占位圆 */
    @property
    public printKind = '';

    /** 文字牌字体(商守贝楷体);空 = 系统默认字体 */
    @property({ type: Font })
    public printFont: Font | null = null;

    /** 文字牌的 Label 子节点缓存 */
    private textLabels: Label[] = [];

    /** 调试:覆盖区域(牌面局部 px 坐标,y 向上),draw() 时以半透明红渲染 */
    public debugCoverage: Array<{ x: number; y: number; w: number; h: number }> | null = null;

    protected start(): void {
        this.draw();
    }

    /** 立即重绘(属性变更后可手动调用) */
    public draw(): void {
        const g = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        const ut = this.node.getComponent(UITransform);
        if (!ut) return;
        const w = ut.width;
        const h = ut.height;
        const r = Math.min(w, h) * 0.1;          // 圆角半径
        const th = this.thickness;                // 厚度

        g.clear();

        // 底部投影(双层椭圆:内层深核 + 外层弥散;2026-11-18 审阅迭代:面积缩至 0.6×)
        const sc = this.shadowScale;
        g.fillColor = new Color(0, 0, 0, Math.round(this.shadowAlpha * 0.4));
        g.ellipse(0, -h / 2 - th + 4, w * 0.50 * sc, 11.5 * sc);
        g.fill();
        g.fillColor = new Color(0, 0, 0, this.shadowAlpha);
        g.ellipse(0, -h / 2 - th + 2, w * 0.42 * sc, 8.5 * sc);
        g.fill();

        if (this.showBack) {
            // ── 绿背形态:侧边上半=背色系,下半=正面色低明度版(底边受光最少) ──
            this.roundRect(g, -w / 2, -h / 2 - th, w, h, r, this.faceColor.clone().lerp(Color.BLACK, 0.25));
            this.roundRect(g, -w / 2, -h / 2 - th / 2, w, h, r, this.backColor.clone().lerp(Color.BLACK, 0.15));
            this.roundRect(g, -w / 2, -h / 2, w, h, r, this.backColor);
            // 顶面外沿描边(转面折边:面向侧面弯折的暗缘;平铺时隔离相邻牌)
            g.lineWidth = 7;
            g.strokeColor = this.backColor.clone().lerp(Color.BLACK, this.edgeShade);
            g.roundRect(-w / 2 + 2.5, -h / 2 + 2.5, w - 5, h - 5, r * 0.8);
            g.stroke();
            this.clearTextPrint();
            return;
        }

        // ── 正面形态 ──
        // 侧边下半:背面色的低明度版(盒体材质透出 + 底边阴影)
        this.roundRect(g, -w / 2, -h / 2 - th, w, h, r, this.backColor.clone().lerp(Color.BLACK, 0.25));
        // 侧边上半:象牙侧色
        this.roundRect(g, -w / 2, -h / 2 - th / 2, w, h, r, this.sideColor);

        // 顶面(象牙白)
        this.roundRect(g, -w / 2, -h / 2, w, h, r, this.faceColor);
        // 顶面外沿描边(转面折边:面向侧面弯折的暗缘;平铺时隔离相邻牌)
        g.lineWidth = 5;
        g.strokeColor = this.faceColor.clone().lerp(Color.BLACK, this.edgeShade);
        g.roundRect(-w / 2 + 2.5, -h / 2 + 2.5, w - 5, h - 5, r * 0.85);
        g.stroke();

        // 印花分发:文字牌(万/风/箭)走 Label;其余走 Graphics 印花库;空串回落占位圆
        const spec = textPrintSpec(this.printKind);
        if (spec) {
            this.applyTextPrint(spec, w, h);
        } else {
            this.clearTextPrint();
            if (!drawPrint(g, this.printKind, w, h)) {
                const cy = h * 0.06;
                const rOuter = Math.min(w, h) * 0.21;
                g.fillColor = this.printColor;
                g.circle(0, cy, rOuter);
                g.fill();
                g.fillColor = this.faceColor;
                g.circle(0, cy, rOuter * 0.38);
                g.fill();
            }
        }

        // 压暗遮罩:淡黑半透明层盖住整个顶面(含印花),表示不可点击
        if (this.dimmed) {
            g.fillColor = new Color(0, 0, 0, 46);
            g.roundRect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2, r * 0.85);
            g.fill();
        }

        // 调试覆盖区(最外层暴露可视化的"被盖住部分",红 = 上层投影∩本牌顶面)
        if (this.debugCoverage && this.debugCoverage.length) {
            g.fillColor = new Color(255, 40, 40, 130);
            for (const c of this.debugCoverage) g.rect(c.x, c.y, c.w, c.h);
            g.fill();
        }
    }

    /** 应用文字牌规格:按需创建 Label 子节点并配置 */
    private applyTextPrint(spec: TextLine[], w: number, h: number): void {
        while (this.textLabels.length < spec.length) {
            const n = new Node('TextPrint');
            n.layer = this.node.layer;
            n.parent = this.node;
            this.textLabels.push(n.addComponent(Label));
        }
        this.textLabels.forEach((lbl, i) => {
            const active = i < spec.length;
            lbl.node.active = active;
            if (!active) return;
            const s = spec[i];
            lbl.string = s.text;
            lbl.fontSize = Math.round(h * s.size);
            lbl.lineHeight = lbl.fontSize;
            lbl.color = Color.fromHEX(new Color(), s.color);
            lbl.isBold = true;
            lbl.overflow = Label.Overflow.NONE;
            lbl.horizontalAlign = Label.HorizontalAlign.CENTER;
            lbl.verticalAlign = Label.VerticalAlign.CENTER;
            if (this.printFont) lbl.font = this.printFont;
            lbl.node.setPosition(0, s.y * h, 0);
        });
    }

    /** 隐藏全部文字牌 Label */
    private clearTextPrint(): void {
        for (const lbl of this.textLabels) lbl.node.active = false;
    }

    /** 填充圆角矩形 */
    private roundRect(g: Graphics, x: number, y: number, w: number, h: number, r: number, color: Color): void {
        g.fillColor = color;
        g.roundRect(x, y, w, h, r);
        g.fill();
    }
}
