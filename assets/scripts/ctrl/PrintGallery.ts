// ============================================================================
// PrintGallery.ts — 印花审阅画廊:全套 34 种麻将牌面
// 行分组(行内居中):
//   饼 5+4 | 条 5+4 | 万 5+4(文字) | 风 4(东南西北) | 箭 3(中/發/白板)
// 文字牌经 Label + printFont(商守贝楷体)渲染
// ============================================================================

import { _decorator, Component, Node, UITransform, Font } from 'cc';
import { TILE } from '../core/tile';
import { MahjongTileArt } from '../view/MahjongTileArt';

const { ccclass, property } = _decorator;

const ROWS: string[][] = [
  ['dot1', 'dot2', 'dot3', 'dot4', 'dot5'],
  ['dot6', 'dot7', 'dot8', 'dot9'],
  ['bam1', 'bam2', 'bam3', 'bam4', 'bam5'],
  ['bam6', 'bam7', 'bam8', 'bam9'],
  ['wan1', 'wan2', 'wan3', 'wan4', 'wan5'],
  ['wan6', 'wan7', 'wan8', 'wan9'],
  ['dong', 'nan', 'xi', 'bei'],
  ['zhong', 'fa', 'blank'],
];

const PITCH_X = 140;
const PITCH_Y = 170;
const UNIT_PX = 30;

@ccclass('PrintGallery')
export class PrintGallery extends Component {

    /** 文字牌字体 */
    @property({ type: Font })
    public font: Font | null = null;

    protected start(): void {
        const rowCount = ROWS.length;
        ROWS.forEach((kinds, row) => {
            kinds.forEach((kind, col) => {
                const n = new Node(`Print_${kind}`);
                n.layer = this.node.layer;
                const ut = n.addComponent(UITransform);
                ut.setContentSize(TILE.w * UNIT_PX, TILE.h * UNIT_PX);
                const art = n.addComponent(MahjongTileArt);
                art.printKind = kind;
                art.printFont = this.font;
                n.parent = this.node;
                n.setPosition((col - (kinds.length - 1) / 2) * PITCH_X, ((rowCount - 1) / 2 - row) * PITCH_Y, 0);
                art.draw();
            });
        });
    }
}
