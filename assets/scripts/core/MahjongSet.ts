// ============================================================================
// MahjongSet.ts — 麻将元素表(内容配置,core 唯一来源)
// 27 种牌型:饼 1-9 / 条 1-9 / 万 1-9;风/箭牌型已在印花库(TilePrints)备用,
// 暂不入池。GameController(现行可玩关卡)与 RandomFill(随机填充)共用。
// ============================================================================

import { ElementDef } from './tile';

const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const PALETTE = ['#E8543F', '#3D7EA6', '#4C8C4A', '#7B52A1', '#D9822B', '#C2527A'];

/** 27 种麻将牌型元素表 */
export function buildMahjongElements(): ElementDef[] {
  const out: ElementDef[] = [];
  const nts: Array<[string, string]> = [];
  for (let n = 1; n <= 9; n++) nts.push([`dot${n}`, `${CN_NUM[n]}饼`]);
  for (let n = 1; n <= 9; n++) nts.push([`bam${n}`, `${CN_NUM[n]}条`]);
  for (let n = 1; n <= 9; n++) nts.push([`wan${n}`, `${CN_NUM[n]}万`]);
  for (const [kind, name] of nts) {
    out.push({
      elementId: kind,
      displayName: name,
      color: PALETTE[out.length % PALETTE.length],
    });
  }
  return out;
}
