// ============================================================================
// TilePrints.ts — 仿麻将印花绘制库(Graphics 程序化,占位美术阶段)
//
// 品种(19):dot1~dot9(一饼~九饼)/ bam1~bam9(一条~九条)/ blank(白板)
// 惯例参照真实麻将:饼=同心圆阵;条=竹节棍(五条中心红棍、七条顶枝红棍,
// 一条为鸟);白板=素面 + 细描边框(与传统"有框白板"一致)。
// 坐标系:调用方牌面局部空间,中心 (0,0),宽 w 高 h。
// ============================================================================

import { Graphics, Color } from 'cc';

const DOT_BLUE = '#2B5F8F';
const DOT_RED = '#B8453A';
const CREAM = '#F3EDDD';
const BAM_GREEN = '#3E7C4F';
const BAM_DARK = '#2E5C3B';
const BAM_RED = '#B8453A';
const BLANK_FRAME = '#9FB4C4';

function hex(g: Graphics, c: string): void {
  g.fillColor = Color.fromHEX(new Color(), c);
}

// ─────────────────────────── 饼(同心圆) ───────────────────────────

/** 单枚饼:多层同心圆(蓝环-米色-红芯) */
function dot(g: Graphics, cx: number, cy: number, r: number): void {
  hex(g, DOT_BLUE);  g.circle(cx, cy, r);        g.fill();
  hex(g, CREAM);     g.circle(cx, cy, r * 0.74); g.fill();
  hex(g, DOT_RED);   g.circle(cx, cy, r * 0.48); g.fill();
  hex(g, CREAM);     g.circle(cx, cy, r * 0.16); g.fill();
}

/** 一饼:大尺寸多环"满饼" */
function bigDot(g: Graphics, cx: number, cy: number, r: number): void {
  hex(g, DOT_RED);   g.circle(cx, cy, r);        g.fill();
  hex(g, CREAM);     g.circle(cx, cy, r * 0.86); g.fill();
  hex(g, DOT_BLUE);  g.circle(cx, cy, r * 0.70); g.fill();
  hex(g, CREAM);     g.circle(cx, cy, r * 0.52); g.fill();
  hex(g, DOT_RED);   g.circle(cx, cy, r * 0.34); g.fill();
  hex(g, CREAM);     g.circle(cx, cy, r * 0.13); g.fill();
}

/** 饼位型:[x 比例(×w), y 比例(×h)],中心原点 */
const DOT_LAYOUTS: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [[0, 0.22], [0, -0.22]],
  3: [[-0.22, 0.24], [0.01, 0], [0.24, -0.24]],                       // 斜排
  4: [[-0.20, 0.22], [0.20, 0.22], [-0.20, -0.22], [0.20, -0.22]],
  5: [[-0.20, 0.24], [0.20, 0.24], [0, 0], [-0.20, -0.24], [0.20, -0.24]],
  6: [[-0.20, 0.27], [0.20, 0.27], [-0.20, 0], [0.20, 0], [-0.20, -0.27], [0.20, -0.27]],
  7: [[-0.22, 0.36], [0, 0.24], [0.22, 0.12],                          // 上斜三 + 下四方
      [-0.17, -0.08], [0.17, -0.08], [-0.17, -0.30], [0.17, -0.30]],
  8: [[-0.18, 0.32], [0.18, 0.32], [-0.18, 0.11], [0.18, 0.11],
      [-0.18, -0.11], [0.18, -0.11], [-0.18, -0.32], [0.18, -0.32]],
  9: [[-0.22, 0.30], [0, 0.30], [0.22, 0.30],
      [-0.22, 0], [0, 0], [0.22, 0],
      [-0.22, -0.30], [0, -0.30], [0.22, -0.30]],
};

function drawDots(g: Graphics, n: number, w: number, h: number): void {
  if (n === 1) { bigDot(g, 0, h * 0.02, w * 0.28); return; }
  const r = n <= 3 ? w * 0.15 : w * 0.11;
  for (const [fx, fy] of DOT_LAYOUTS[n]) dot(g, fx * w, fy * h, r);
}

// ─────────────────────────── 条(竹节棍) ───────────────────────────

interface StickSpec { x: number; y: number; horiz?: boolean; red?: boolean; len?: number; }

/** 竹节棍:圆角长条 + 两道竹节线 */
function stick(g: Graphics, cx: number, cy: number, ws: number, len: number, horiz: boolean, red: boolean): void {
  const color = red ? BAM_RED : BAM_GREEN;
  const w_ = horiz ? len : ws;
  const h_ = horiz ? ws : len;
  hex(g, color);
  g.roundRect(cx - w_ / 2, cy - h_ / 2, w_, h_, ws * 0.45);
  g.fill();
  // 竹节线(米色)
  g.lineWidth = 1.5;
  g.strokeColor = Color.fromHEX(new Color(), CREAM);
  const off = len * 0.18;
  for (const d of [-off, off]) {
    g.moveTo(horiz ? cx + d : cx - ws / 2, horiz ? cy - ws / 2 : cy + d);
    g.lineTo(horiz ? cx + d : cx + ws / 2, horiz ? cy + ws / 2 : cy + d);
  }
  g.stroke();
}

const BAM_LAYOUTS: Record<number, StickSpec[]> = {
  2: [{ x: 0, y: 0.22 }, { x: 0, y: -0.22 }],
  3: [{ x: -0.16, y: 0.22 }, { x: 0.16, y: 0.22 }, { x: 0, y: -0.20 }],
  4: [{ x: -0.16, y: 0.22 }, { x: 0.16, y: 0.22 }, { x: -0.16, y: -0.22 }, { x: 0.16, y: -0.22 }],
  5: [{ x: -0.18, y: 0.24 }, { x: 0.18, y: 0.24 }, { x: 0, y: 0, red: true },
      { x: -0.18, y: -0.24 }, { x: 0.18, y: -0.24 }],
  6: [{ x: -0.30, y: 0.16, horiz: true, len: 0.16 }, { x: 0, y: 0.16, horiz: true, len: 0.16 }, { x: 0.30, y: 0.16, horiz: true, len: 0.16 },
      { x: -0.30, y: -0.16, horiz: true, len: 0.16 }, { x: 0, y: -0.16, horiz: true, len: 0.16 }, { x: 0.30, y: -0.16, horiz: true, len: 0.16 }],
  7: [{ x: 0, y: 0.24, red: true, len: 0.22 },
      { x: -0.30, y: -0.02, horiz: true, len: 0.16 }, { x: 0, y: -0.02, horiz: true, len: 0.16 }, { x: 0.30, y: -0.02, horiz: true, len: 0.16 },
      { x: -0.30, y: -0.28, horiz: true, len: 0.16 }, { x: 0, y: -0.28, horiz: true, len: 0.16 }, { x: 0.30, y: -0.28, horiz: true, len: 0.16 }],
  8: [{ x: -0.16, y: 0.32, len: 0.17 }, { x: 0.16, y: 0.32, len: 0.17 }, { x: -0.16, y: 0.11, len: 0.17 }, { x: 0.16, y: 0.11, len: 0.17 },
      { x: -0.16, y: -0.11, len: 0.17 }, { x: 0.16, y: -0.11, len: 0.17 }, { x: -0.16, y: -0.32, len: 0.17 }, { x: 0.16, y: -0.32, len: 0.17 }],
  9: [{ x: -0.20, y: 0.28, len: 0.22 }, { x: 0, y: 0.28, len: 0.22 }, { x: 0.20, y: 0.28, len: 0.22 },
      { x: -0.20, y: 0, len: 0.22 }, { x: 0, y: 0, len: 0.22 }, { x: 0.20, y: 0, len: 0.22 },
      { x: -0.20, y: -0.28, len: 0.22 }, { x: 0, y: -0.28, len: 0.22 }, { x: 0.20, y: -0.28, len: 0.22 }],
};

function drawBams(g: Graphics, n: number, w: number, h: number): void {
  if (n === 1) { drawBird(g, w, h); return; }
  const ws = w * 0.09;
  for (const s of BAM_LAYOUTS[n]) {
    stick(g, s.x * w, s.y * h, ws, h * (s.len ?? 0.34), !!s.horiz, !!s.red);
  }
}

/** 一条:小鸟(身/头/喙/眼/翅/尾,简化形) */
function drawBird(g: Graphics, w: number, h: number): void {
  const cx = 0, cy = h * 0.04;
  // 尾羽(三片扇形)
  hex(g, BAM_DARK);
  for (const a of [-0.35, 0, 0.35]) {
    g.moveTo(cx - w * 0.14, cy + a * h * 0.1);
    g.lineTo(cx - w * 0.34, cy + a * h * 0.22 - h * 0.04);
    g.lineTo(cx - w * 0.16, cy + a * h * 0.1 + h * 0.04);
    g.close();
    g.fill();
  }
  // 身体
  hex(g, BAM_GREEN);
  g.ellipse(cx, cy, w * 0.19, h * 0.15);
  g.fill();
  // 翅膀
  hex(g, BAM_DARK);
  g.ellipse(cx - w * 0.02, cy - h * 0.01, w * 0.11, h * 0.075);
  g.fill();
  // 头
  hex(g, BAM_GREEN);
  g.circle(cx + w * 0.17, cy + h * 0.11, w * 0.10);
  g.fill();
  // 喙
  hex(g, '#D9822B');
  g.moveTo(cx + w * 0.26, cy + h * 0.10);
  g.lineTo(cx + w * 0.38, cy + h * 0.12);
  g.lineTo(cx + w * 0.26, cy + h * 0.15);
  g.close();
  g.fill();
  // 眼
  hex(g, '#FFFFFF'); g.circle(cx + w * 0.20, cy + h * 0.13, w * 0.028); g.fill();
  hex(g, '#222222'); g.circle(cx + w * 0.21, cy + h * 0.13, w * 0.014); g.fill();
  // 足
  g.lineWidth = 2;
  g.strokeColor = Color.fromHEX(new Color(), '#8A6D3B');
  g.moveTo(cx - w * 0.03, cy - h * 0.14); g.lineTo(cx - w * 0.05, cy - h * 0.22);
  g.moveTo(cx + w * 0.07, cy - h * 0.14); g.lineTo(cx + w * 0.09, cy - h * 0.22);
  g.stroke();
}

// ─────────────────────────── 白板 ───────────────────────────

function drawBlank(g: Graphics, w: number, h: number): void {
  g.lineWidth = 9;
  g.strokeColor = Color.fromHEX(new Color(), BLANK_FRAME);
  g.roundRect(-w / 2 + 20, -h / 2 + 20, w - 40, h - 40, 12);
  g.stroke();
}

// ─────────────────────────── 文字牌(万/风/箭,经 Label 渲染) ───────────────────────────

export interface TextLine {
  text: string;
  color: string;
  /** 字号(×h 比例) */
  size: number;
  /** 纵向位置(×h 比例,中心 0) */
  y: number;
}

const WAN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const WIND_CHAR: Record<string, string> = { dong: '東', nan: '南', xi: '西', bei: '北' };
const WAN_RE = /^wan([1-9])$/;

/** 文字牌规格:wan1~9(上数字蓝/下萬红)、dong/nan/xi/bei(风,蓝)、zhong(中,红)、fa(發,绿) */
export function textPrintSpec(kind: string): TextLine[] | null {
  const wan = WAN_RE.exec(kind);
  if (wan) {
    return [
      { text: WAN_NUM[Number(wan[1])], color: DOT_BLUE, size: 0.30, y: 0.24 },
      { text: '萬', color: DOT_RED, size: 0.36, y: -0.16 },
    ];
  }
  const wind = WIND_CHAR[kind];
  if (wind) return [{ text: wind, color: DOT_BLUE, size: 0.50, y: 0 }];
  if (kind === 'zhong') return [{ text: '中', color: DOT_RED, size: 0.54, y: 0 }];
  if (kind === 'fa') return [{ text: '發', color: BAM_GREEN, size: 0.52, y: 0 }];
  return null;
}

// ─────────────────────────── 分发 ───────────────────────────

const DOT_RE = /^dot([1-9])$/;
const BAM_RE = /^bam([1-9])$/;

/** 绘制印花;未知/空 kind 返回 false(调用方回落默认占位) */
export function drawPrint(g: Graphics, kind: string, w: number, h: number): boolean {
  const d = DOT_RE.exec(kind);
  if (d) { drawDots(g, Number(d[1]), w, h); return true; }
  const b = BAM_RE.exec(kind);
  if (b) { drawBams(g, Number(b[1]), w, h); return true; }
  if (kind === 'blank') { drawBlank(g, w, h); return true; }
  return false;
}
