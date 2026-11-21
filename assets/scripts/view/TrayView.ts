// ============================================================================
// TrayView.ts — 槽位托盘(木条 + 4 凹槽,Graphics 绘制)
// 职责:托盘表现 + 提供各槽位的 world 坐标(牌的飞行目标);
// 槽内牌本体仍挂在 PileView 下(跨父级动画归控制器调度)
// ============================================================================

import { _decorator, Component, Graphics, UITransform, Vec3, Color } from 'cc';

const { ccclass } = _decorator;

const BAR_COLOR = '#8B5E3C';
const BAR_EDGE = '#5C3A24';
const CELL_COLOR = '#74492E';
const CELL_EDGE = '#4E3220';

@ccclass('TrayView')
export class TrayView extends Component {

    /** 槽位横向间距(px) */
    public readonly slotPitch = 144;

    /** 槽位 i(0..3)中心的世界坐标 */
    public slotWorldPos(i: number): Vec3 {
        const ut = this.node.getComponent(UITransform)!;
        return ut.convertToWorldSpaceAR(new Vec3((i - 1.5) * this.slotPitch, 0, 0)).add3f(0, 30, 0);
    }

    protected start(): void {
        this.draw();
    }

    private draw(): void {
        const g = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        const barW = 4 * this.slotPitch + 48;
        const barH = 196;

        g.clear();

        // 托盘木条
        g.fillColor = Color.fromHEX(new Color(), BAR_COLOR);
        g.roundRect(-barW / 2, -barH / 2, barW, barH, 26);
        g.fill();
        g.lineWidth = 4;
        g.strokeColor = Color.fromHEX(new Color(), BAR_EDGE);
        g.roundRect(-barW / 2 + 2, -barH / 2 + 2, barW - 4, barH - 4, 24);
        g.stroke();

        // 顶部受光高光线
        g.lineWidth = 3;
        g.strokeColor = Color.fromHEX(new Color(), '#A97B55');
        g.moveTo(-barW / 2 + 20, barH / 2 - 10);
        g.lineTo(barW / 2 - 20, barH / 2 - 10);
        g.stroke();

        // 4 个凹槽
        for (let i = 0; i < 4; i++) {
            const cx = (i - 1.5) * this.slotPitch;
            g.fillColor = Color.fromHEX(new Color(), CELL_COLOR);
            g.roundRect(cx - 66, -83, 132, 166, 16);
            g.fill();
            g.lineWidth = 3;
            g.strokeColor = Color.fromHEX(new Color(), CELL_EDGE);
            g.roundRect(cx - 66, -83, 132, 166, 16);
            g.stroke();
        }
    }
}
