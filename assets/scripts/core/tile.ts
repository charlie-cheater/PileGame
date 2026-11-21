// ============================================================================
// tile.ts — 麻将牌(盲盒)基础数据结构【定稿 2026-11-18 · 遮挡口径 v2 同日修订】
// 逻辑层核心数据契约,修改需经设计者确认
//
// 分层原则:
//   定义态 TileDef    —— 关卡 JSON 中的出厂属性,不可变
//   运行态 Tile       —— GameController 实例化与管理,随玩法推进变化
//   派生态 TileDerived —— 每次牌堆变化后重算,不落盘
//
// 单位系统:
//   逻辑层的全部几何量(牌宽高、布局区域尺寸、摆放坐标)使用虚拟单位 unit,
//   且只能为该单位的整数倍;表现层通过 UnitMapping 指定 1 unit 的渲染映射
//   尺寸,逻辑层对像素零依赖。
//
// 遮挡口径(非对称;v2 2026-11-18 确认,v2.1 同层修正,v2.2 侧边免阈 2026-11-19 确认):
//   牌逻辑上分为顶面(信息面)与侧面(厚度)两个部分;
//   遮挡者跨层时:面对面覆盖超阈,或 侧边擦及顶面任意面积 → 挡(侧边免阈);
//   遮挡者同层时:仅面对面覆盖超阈;侧边不计(渗入由绘制顺序消化);
//   被遮挡者仅保护顶面——侧面被覆盖不论占比均不构成有效遮挡。
// ============================================================================

// ─────────────────────────── 基础类型 ───────────────────────────

/** 二分符号·半别 */
export type TileVariant =
  | 'L'      // 左半(玩具左半图)
  | 'R'      // 右半(玩具右半图)
  | 'FULL';  // 整图(混式难度预留:FULL+FULL 可配对)

/** 生命周期状态 */
export type TileStatus =
  | 'pile'        // 在牌堆中(可点性由派生态决定)
  | 'slot'        // 已飞入槽位托盘
  | 'eliminated'; // 已消除

/** 元素 id = 配对家族标识。约定:小写英文短名,如 'marble'、'pinwheel' */
export type ElementId = string;

/** 逻辑几何量:一律为 unit 的整数倍(坐标/尺寸均为非负整数) */
export type Unit = number;

// ─────────────────────────── 定义态(关卡数据) ───────────────────────────

export interface TileDef {
  /** 所属玩具元素(配对家族),引用 ElementDef.elementId */
  elementId: ElementId;

  /** 半别:同 elementId 的 L+R 互补可配;FULL+FULL 可配 */
  variant: TileVariant;

  /** 牌左上角的 X 坐标(unit 整数,相对布局区域原点)。
   *  交错摆放由不同整数坐标自然涌现,无半格特殊语义。
   */
  gx: Unit;

  /** 牌左上角的 Y 坐标(unit 整数) */
  gy: Unit;

  /** 层号,0 = 最底层。
   *  用途:① 渲染 z 序;② 遮挡裁决的第一关键字(见 blocked 规则)。
   */
  layer: number;

  /** 同层内 z 序(可选,默认 0)。
   *  遮挡裁决第二关键字:layer 相同而矩形重叠时,subZ 大者压小者,
   *  避免"同层互压 → 互相锁死"。未显式给出时,以关卡数组序兜底。
   */
  subZ?: number;
}

// ─────────────────────────── 元素表(配对家族定义) ───────────────────────────

export interface ElementDef {
  /** 配对家族标识 */
  elementId: ElementId;

  /** 展示名(中文,HUD/图鉴用),如 '玻璃弹珠' */
  displayName: string;

  /** 独占底色(HEX)——二分符号"颜色粗分类"防线的落点 */
  color: string;

  /** 稀有度(玩具经济系统预留,可选) */
  rarity?: 'normal' | 'rare' | 'hidden';
}

// ─────────────────────────── 运行态(GameController 管理) ───────────────────────────

export interface Tile extends TileDef {
  /** 运行时唯一实例 id(撤回寻址/动画追踪);= 关卡数组下标即可满足 */
  tileId: number;

  /** 生命周期状态,流转:pile → slot → eliminated;撤回:slot → pile */
  status: TileStatus;

  /** status === 'slot' 时所在槽位下标(0..3);其余状态为 null */
  slotIndex: number | null;
}

// ─────────────────────────── 派生态(重算,不落盘) ───────────────────────────

/** 逻辑矩形,全部字段为 unit 整数 */
export interface UnitRect {
  x: Unit;
  y: Unit;
  w: Unit;
  h: Unit;
}

export interface TileDerived {
  /** 被压判定(非对称口径 v2.2):
   *  存在牌 t'(status='pile',t'≠t),满足
   *  ① zOf(t') > zOf(t),其中 zOf = (layer, subZ) 字典序
   *  ② 面对面:overlapArea(faceRect(t'), faceRect(t)) / area(faceRect(t)) > 阈值
   *  ③ 或 跨层侧边免阈:t'.layer > t.layer 且
   *     overlapArea(sideRect(t'), faceRect(t)) > 0(任意面积即挡)
   *  —— 同层侧边不计(任何面积;绘制序消化);
   *     被遮挡者受保护面 = 仅顶面(规则⑥)。
   *  面积单位 unit²,比值无量纲、与渲染映射无关;
   *  侧边视觉圆角按矩形近似(边角误差 < 1 unit,可忽略)。
   */
  blocked: boolean;

  /** 可点 = status === 'pile' && !blocked */
  clickable: boolean;

  /** 顶面矩形(信息面):被遮挡判定对象,亦即点击命中区 */
  faceRect: UnitRect;

  /** 侧面矩形(厚度的逻辑足迹):位于顶面下缘之下 TILE.sideH 高,仅作为遮挡者参与 */
  sideRect: UnitRect;

  /** 视觉体投影 = 顶面 ∪ 侧面(同宽相接,恰为矩形),遮挡计算用 */
  totalRect: UnitRect;
}

// ─────────────────────────── 几何常量(占位值,待布局系统定稿) ───────────────────────────

export const TILE = {
  /** 顶面逻辑尺寸(unit 整数;8:10 = 4:5 视觉比例;取偶高度使 0.5 tile = 整数 unit,
   *  纵向半张步长因此合法 —— 2026-11-19 设计指示) */
  w: 8 as Unit,
  h: 10 as Unit,
  /** 侧面(厚度)逻辑高度(维持顶面高度 1/5 的比例;自顶面下缘向下延伸;仅作遮挡者参与) */
  sideH: 2 as Unit,
  /** 遮挡面积阈值:顶面被(遮挡者视觉体投影)覆盖超过 18% 才算被压
   *  (无量纲比值,占位,需手感调参;非对称口径下密集关卡挡格率略升,可上调至 0.20~0.25) */
  overlapThreshold: 0.18,
} as const;

// ─────────────────────────── 单位映射契约(表现层实现,逻辑层不依赖) ───────────────────────────

/** 表现层声明:1 unit 渲染为多少像素(设计分辨率下)。
 *  换算:px = unit × unitPx;适配缩放由视图层在 unitPx 之上叠加。
 *  一致性约束(见不变量 I6):渲染层牌厚度像素必须 = TILE.sideH × unitPx。
 *  逻辑层禁止 import 本类型的实现,只允许在注释/文档中引用该契约。
 */
export interface UnitMapping {
  unitPx: number;
}

// ─────────────────────────── 配对判定(纯函数) ───────────────────────────

/** 配对判定:同 elementId 且半别互补(L+R / R+L / FULL+FULL) */
export function canPair(a: Tile, b: Tile): boolean {
  if (a.elementId !== b.elementId) return false;
  if (a.variant === 'FULL') return b.variant === 'FULL';
  return (a.variant === 'L' && b.variant === 'R')
      || (a.variant === 'R' && b.variant === 'L');
}

/** 在槽位数组中找出第一组可配对下标(槽内自动检测用);无则返回 null */
export function findPairInSlot(tray: ReadonlyArray<Tile | null>): [number, number] | null {
  for (let i = 0; i < tray.length; i++) {
    const a = tray[i];
    if (!a) continue;
    for (let j = i + 1; j < tray.length; j++) {
      const b = tray[j];
      if (b && canPair(a, b)) return [i, j];
    }
  }
  return null;
}

// ─────────────────────────── 宿主关系(关卡数据,完整结构后续另行设计) ───────────────────────────

export interface LevelData {
  /** 布局区域尺寸(unit 整数,如 { w: 40, h: 48 };牌堆坐标系的上界) */
  board: { w: Unit; h: Unit };

  /** 本关用到的元素表 */
  elements: ElementDef[];

  /** 全部牌;数组序 = 同层 subZ 未显式声明时的兜底次序 */
  tiles: TileDef[];
}

// ─────────────────────────── 数据不变量(校验职责归 LevelCodec) ───────────────────────────

// I1 可解性基础:每个 elementId 的 L 张数 === R 张数;FULL 为偶数张
// I2 引用完整:每张牌的 elementId 必须存在于 elements 表
// I3 槽位约束:运行中 status='slot' 的牌数 ≤ 4(满 4 且 findPairInSlot 为 null → 失败)
// I4 单位整数:gx/gy、TILE.w/h/sideH、board.w/h 均为非负整数(unit 制);layer、subZ 为非负整数
// I5 区域边界:每张牌满足 gx+TILE.w ≤ board.w、gy+TILE.h ≤ board.h 且 gy ≥ TILE.sideH
//             (顶面不出界,且侧面下缘不越过布局区域下界,保证派生矩形均为非负坐标)
// I6 视觉一致(跨层约束):渲染层牌厚度 px === TILE.sideH × unitPx
//    (主场景 sideH=2 × 15px/unit = 30px;预览 2 × 7 = 14px)
