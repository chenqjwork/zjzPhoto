/**
 * 人像抠图：MediaPipe Tasks Vision ImageSegmenter + selfie_multiclass 模型。
 *
 * ── 为什么选 MediaPipe ImageSegmenter（而不是 @imgly/background-removal / ISNet）
 *   1. 许可证：@imgly/background-removal 为 AGPL-3.0，商用需另行购买授权；
 *      MediaPipe 与其官方模型均为 Apache-2.0，可自由使用。
 *   2. 国内可达性：ISNet 权重 44MB~176MB，只能从 staticimgly.com 拉取；
 *      selfie_multiclass 为 15.6MB，自托管成本低。
 *   3. 依赖收敛：与自动裁切所需的 FaceDetector 同属 @mediapipe/tasks-vision，
 *      复用同一套 WASM 运行时，无需再引入 onnxruntime-web。
 *   4. 精度补偿：模型输出经「α 边缘精修（refine.ts）」，边缘再做
 *      颜色去污染（color.ts），保证换底色后无明显白边。
 *
 * ── 模型选择上的一个坑（已在 fetch-models.mjs 中标注）
 *   不要用 image_segmenter/selfie_segmenter（244KB）：它属于旧的 MLKit
 *   SelfieSegmentation，输出张量名为 conv2d_31/BiasAdd，Tasks 版
 *   ImageSegmenter 无法解读（实测 categoryMask 全 255、confidence 全 0）。
 *   selfie_multiclass_256x256 才是 Tasks 官方模型，输出 6 类：
 *     0 背景 · 1 头发 · 2 身体皮肤 · 3 面部皮肤 · 4 衣服 · 5 配饰
 *
 * 所有模型与 WASM 均从本站 public/ 同源加载，运行时不访问任何外部 CDN。
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

/**
 * 资源基址：以「页面」为基准解析，而不是以 JS 模块文件为基准。
 * 这样无论产物挂在域名根目录还是子路径，都能正确定位到 public/ 下的模型。
 */
export const assetUrl = (path: string): string =>
  new URL(path.replace(/^\.\//, ''), document.baseURI).toString();

/** selfie_multiclass 类别数：0=背景，1..5=人像部位 */
const CLASS_COUNT = 6;
/** 参与「前景」判定的类别（全部非背景类） */
const FOREGROUND_CLASSES = [1, 2, 3, 4, 5];

let segmenterPromise: Promise<ImageSegmenter> | null = null;

export function isSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof createImageBitmap === 'function';
}

/** 惰性创建并复用 segmenter 实例（多次抠图不会重复加载模型） */
export function getSegmenter(onProgress?: (msg: string) => void): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      onProgress?.('加载推理运行时…');
      const fileset = await FilesetResolver.forVisionTasks(assetUrl('./wasm'));

      onProgress?.('加载人像分割模型…');
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: assetUrl('./models/selfie_multiclass_256x256.tflite'),
          delegate: 'GPU'
        },
        runningMode: 'IMAGE',
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });
    })().catch((err) => {
      segmenterPromise = null; // 允许失败后重试
      throw err;
    });
  }
  return segmenterPromise;
}

/**
 * 阈值相关常量。
 *
 * selfie_multiclass 的 softmax 输出是强双峰分布：
 *   - 背景像素：前景置信度集中在 0.01~0.03（噪声底）
 *   - 前景像素：前景置信度明显高于背景置信度，落在 0.45~0.84
 * 因此不能简单用 confidence×255，而要先做「前景 vs 背景」的判别，
 * 再把剩余区间线性拉伸到完整 0..255。
 *
 * 阈值按「背景置信度」自适应：背景越确信，判定前景的门槛越高。
 */
const NOISE_FLOOR = 0.045; // 前景置信度噪声底
const MIN_MARGIN = 1.08; // 前景置信度至少需为背景的 1.08 倍
const MIN_MARGIN_RELAXED = 1.02; // 弱证据区域的宽松下限（用于保住发丝）
const FULL_ALPHA_MARGIN = 1.45; // 前景/背景置信度比达到此值视为纯前景

/**
 * 对图片做前景分割，返回与原图同尺寸的 alpha 掩膜（0..255）。
 */
export async function segmentPerson(
  source: ImageBitmap | HTMLCanvasElement,
  onProgress?: (msg: string) => void
): Promise<Uint8Array> {
  const segmenter = await getSegmenter(onProgress);
  const width = source.width;
  const height = source.height;

  onProgress?.('正在识别人像…');
  const result = segmenter.segment(source);
  const masks = result.confidenceMasks;

  if (!masks || masks.length < CLASS_COUNT) {
    result.close();
    const got = masks?.length ?? 0;
    throw new Error(
      `分割模型输出异常（期望 ${CLASS_COUNT} 个掩膜，实际 ${got} 个）。请执行 npm run fetch:models 确认模型文件正确`
    );
  }

  const maskW = masks[0].width;
  const maskH = masks[0].height;
  const layers: Float32Array[] = masks.map((m) => m.getAsFloat32Array());
  const total = maskW * maskH;

  const background = layers[0];
  const foreground = new Float32Array(total);
  let fgMax = 0;
  for (let i = 0; i < total; i++) {
    let m = 0;
    for (const c of FOREGROUND_CLASSES) {
      if (c >= layers.length) break;
      const v = layers[c][i];
      if (v > m) m = v;
    }
    foreground[i] = m;
    if (m > fgMax) fgMax = m;
  }

  if (fgMax <= NOISE_FLOOR) {
    result.close();
    throw new Error('未能在照片中识别人像，请换一张正面免冠、人物占比较大的清晰照片');
  }

  // 背景置信度均值 → 自适应抬高门槛
  let bgMean = 0;
  for (let i = 0; i < total; i++) bgMean += background[i];
  bgMean /= total;
  // 背景越确信（bgMean 越高），要求的对比度倍数越高
  const margin = MIN_MARGIN + Math.max(0, bgMean - 0.5) * 0.25;
  const relaxed = Math.min(MIN_MARGIN_RELAXED, margin - 0.06);

  const alpha = new Uint8Array(width * height);
  const needResample = maskW !== width || maskH !== height;
  const xRatio = needResample && maskW > 1 ? (maskW - 1) / Math.max(1, width - 1) : 0;
  const yRatio = needResample && maskH > 1 ? (maskH - 1) / Math.max(1, height - 1) : 0;

  /** 由「前景置信度 / 背景置信度」算出 0..1 的 α */
  const alphaAt = (fg: number, bg: number): number => {
    if (fg <= NOISE_FLOOR) return 0;
    const ratio = bg > 1e-4 ? fg / bg : Number.POSITIVE_INFINITY;
    if (ratio <= relaxed) return 0;
    if (ratio >= FULL_ALPHA_MARGIN) return 1;
    // 在 (relaxed, FULL_ALPHA_MARGIN) 区间线性过渡
    return (ratio - relaxed) / (FULL_ALPHA_MARGIN - relaxed);
  };

  const sampleAt = (x: number, y: number): { fg: number; bg: number } => {
    if (!needResample) {
      const i = y * maskW + x;
      return { fg: foreground[i], bg: background[i] };
    }
    const sx = x * xRatio;
    const sy = y * yRatio;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(maskW - 1, x0 + 1);
    const y1 = Math.min(maskH - 1, y0 + 1);
    const wx = sx - x0;
    const wy = sy - y0;
    const bilinear = (arr: Float32Array) => {
      const top = arr[y0 * maskW + x0] + (arr[y0 * maskW + x1] - arr[y0 * maskW + x0]) * wx;
      const bottom = arr[y1 * maskW + x0] + (arr[y1 * maskW + x1] - arr[y1 * maskW + x0]) * wx;
      return top + (bottom - top) * wy;
    };
    return { fg: bilinear(foreground), bg: bilinear(background) };
  };

  let covered = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { fg, bg } = sampleAt(x, y);
      const a = alphaAt(fg, bg);
      const v = Math.round(a * 255);
      alpha[y * width + x] = v;
      if (v > 128) covered++;
    }
  }

  // 前景占比过低视为没抠到人
  if (covered / (width * height) < 0.005) {
    result.close();
    throw new Error('未能在照片中识别人像，请换一张人物更清晰、占画面更大的照片');
  }

  result.close();
  return alpha;
}
