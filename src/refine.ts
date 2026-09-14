/**
 * alpha 掩膜边缘精修。
 *
 * 分割模型在 256×256 上推理，直接上采样会有两个问题：
 *   1. 边缘出现阶梯状锯齿；
 *   2. 前景内部（尤其面部、肩部这些模型置信度偏低的区域）出现「空洞」，
 *      换底色后会露出背景色斑块。
 *
 * 因此精修分两步，且必须区分「边缘带」和「前景内部」：
 *   1. 形态学闭运算（先膨胀后腐蚀）填补内部小空洞，同时平滑锯齿；
 *   2. 对闭运算结果做温和模糊，得到自然过渡的边缘；
 *   3. 只在「边缘带」（0 < α < 1）做对比度拉伸，拉开前景/背景，
 *      不触碰已经完全确定的前景内部，避免误伤面部等低置信度区域。
 */

/** 3×3 最大值（膨胀） */
function dilate(src: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const base = yy * width;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = src[base + xx];
          if (v > m) m = v;
        }
      }
      out[row + x] = m;
    }
  }
  return out;
}

/** 3×3 最小值（腐蚀） */
function erode(src: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const base = yy * width;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = src[base + xx];
          if (v < m) m = v;
        }
      }
      out[row + x] = m;
    }
  }
  return out;
}

/** 可分离盒式模糊，半径 r */
function boxBlur(src: Float32Array, width: number, height: number, r: number): Float32Array {
  if (r < 1) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = r * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(width - 1, Math.max(0, i))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + Math.min(width - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[Math.min(height - 1, Math.max(0, i)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / win;
      sum += tmp[Math.min(height - 1, y + r + 1) * width + x] - tmp[Math.max(0, y - r) * width + x];
    }
  }
  return out;
}

export interface RefineOptions {
  /** 闭运算半径（按短边比例），用于填内部空洞 + 平滑锯齿 */
  closeRadius?: number;
  /** 边缘模糊半径（按短边比例） */
  blurRadius?: number;
  /** 判定「边缘带」的上下阈值，只在该区间做对比度拉伸 */
  edgeLow?: number;
  edgeHigh?: number;
}

/**
 * 精修 alpha 掩膜，返回新的 Uint8 掩膜（不修改入参）。
 */
export function refineAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  options: RefineOptions = {}
): Uint8Array {
  const shortEdge = Math.min(width, height);
  const closeRadius = options.closeRadius ?? Math.max(1, Math.round(shortEdge * 0.004));
  const blurRadius = options.blurRadius ?? Math.max(1, Math.round(shortEdge * 0.0025));
  const edgeLow = options.edgeLow ?? 0.06;
  const edgeHigh = options.edgeHigh ?? 0.94;

  const f = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) f[i] = alpha[i] / 255;

  // 1. 闭运算：先膨胀后腐蚀 —— 填补内部空洞、连通碎片、消除锯齿
  let closed = f;
  for (let i = 0; i < closeRadius; i++) closed = dilate(closed, width, height);
  for (let i = 0; i < closeRadius; i++) closed = erode(closed, width, height);

  // 2. 温和模糊，得到自然过渡的边缘（保持体积感，不做形态学重建）
  const blurred = boxBlur(closed, width, height, blurRadius);

  // 3. 只在边缘带内做对比度拉伸，前景/背景主体保持原样
  const out = new Uint8Array(alpha.length);
  const span = Math.max(1e-4, edgeHigh - edgeLow);
  for (let i = 0; i < alpha.length; i++) {
    const v = blurred[i];
    let mapped: number;
    if (v <= edgeLow) mapped = 0;
    else if (v >= edgeHigh) mapped = 1;
    else mapped = (v - edgeLow) / span;
    out[i] = Math.round(mapped * 255);
  }
  return out;
}
