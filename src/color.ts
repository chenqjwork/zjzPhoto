/**
 * 颜色工具：解析 Hex、以及在抠图结果上做「颜色去污染 + 换底色」合成。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 解析 #RGB / #RRGGBB 形式的颜色，非法值返回 null */
export function parseHex(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16)
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }
  return null;
}

export const toHex = ({ r, g, b }: Rgb): string =>
  '#' +
  [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** 相对亮度，用于决定色板文字用黑色还是白色 */
export function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 估算原图背景色（去污染公式里的 B）。
 *
 * 半透明边缘像素是「前景色 F」和「原背景色 B」按 α 混合的结果：
 *   C = α·F + (1-α)·B
 * 要去掉 B 的污染就必须知道 B。这里用图像四条边的像素做中位数统计
 * —— 证件照原图背景通常占据边缘，且同一张照片背景色接近。
 *
 * @param data   原始 RGBA 像素（未被抠图修改）
 * @param width  宽
 * @param height 高
 * @param alpha  同一尺寸的 alpha 掩膜（0..255）
 */
export function estimateBackgroundColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alpha: Uint8Array
): Rgb {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.02));

  const push = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    // 只统计「原背景」位置的像素：alpha 接近 0，说明该处确实被判定为背景
    if (alpha[y * width + x] > 32) return;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < band || x >= width - band || y < band || y >= height - band;
      if (edge) push(x, y);
    }
  }

  if (rs.length < 64) return { r: 255, g: 255, b: 255 }; // 找不到背景，退回白色
  const median = (arr: number[]) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/** 去污染时保留前景纯色的最小 α，低于此值不再反解（避免数值爆炸产生彩噪） */
const DECONTAM_MIN_ALPHA = 0.05;
/** 去污染在边缘带内的强度上限，超过后按纯前景处理 */
const DECONTAM_MAX_ALPHA = 0.99;

export interface CompositeOptions {
  /** 目标底色 */
  background: Rgb;
  /** 估算出的原背景色，用于去污染；传 null 表示跳过去污染 */
  sourceBackground: Rgb | null;
  /** 去污染强度 0..1，1 表示完全按公式反解，0 表示关闭 */
  strength?: number;
}

/**
 * 将「前景 + alpha」按去污染公式合成到新底色上。
 *
 * 推导：
 *   观测像素 C 是原始前景 F 与原背景 B 的混合：C = α·F + (1-α)·B
 *   反解前景：F = (C - (1-α)·B) / α
 *   再与目标底色 G 合成：Out = α·F + (1-α)·G
 *
 * 若不反解，直接 Out = α·C + (1-α)·G，边缘会带着原背景色（白墙 → 白边）。
 *
 * @param data   原图 RGBA 像素，函数内直接改写
 * @param alpha  抠图得到的 alpha 掩膜（0..255）
 * @param width  宽
 * @param height 高
 */
export function applyBackground(
  data: Uint8ClampedArray,
  alpha: Uint8Array,
  width: number,
  height: number,
  options: CompositeOptions
): void {
  const { background, sourceBackground } = options;
  const strength = options.strength ?? 1;
  const total = width * height;

  for (let p = 0; p < total; p++) {
    const i = p * 4;
    const a = alpha[p] / 255;

    if (a <= 0) {
      // 完全背景：直接铺底色
      data[i] = background.r;
      data[i + 1] = background.g;
      data[i + 2] = background.b;
      data[i + 3] = 255;
      continue;
    }

    let fr = data[i];
    let fg = data[i + 1];
    let fb = data[i + 2];

    if (sourceBackground && strength > 0 && a < DECONTAM_MAX_ALPHA && a > DECONTAM_MIN_ALPHA) {
      // F = (C - (1-α)·B) / α
      const inv = (1 - a) * strength;
      fr = (data[i] - inv * sourceBackground.r) / a;
      fg = (data[i + 1] - inv * sourceBackground.g) / a;
      fb = (data[i + 2] - inv * sourceBackground.b) / a;
      // 限制到有效色域，避免反解溢出产生彩噪
      fr = fr < 0 ? 0 : fr > 255 ? 255 : fr;
      fg = fg < 0 ? 0 : fg > 255 ? 255 : fg;
      fb = fb < 0 ? 0 : fb > 255 ? 255 : fb;
    }

    // Out = α·F + (1-α)·G
    const ia = 1 - a;
    data[i] = fr * a + background.r * ia;
    data[i + 1] = fg * a + background.g * ia;
    data[i + 2] = fb * a + background.b * ia;
    data[i + 3] = 255;
  }
}
