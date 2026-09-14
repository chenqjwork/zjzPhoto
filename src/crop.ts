/**
 * 自动裁切：把原图裁成目标证件照比例，并让头部占比符合规范。
 *
 * 规范（国内证件照通行做法）：
 *   - 人像居中：脸部水平中心对齐画面水平中心
 *   - 头部高度（发顶到下巴）约占画面高度的 55%~65%，取 0.6
 *   - 头顶留白约 8%~12% 画面高度，取 0.1
 *
 * 关于 BlazeFace 的框：
 *   blaze_face_short_range 输出的是「包含整个头部」的近似正方形框
 *   （以本仓库测试图为例，框高 226px，实际发顶到下巴约 302px）。
 *   因此不能把框当成「只有五官的脸」，相反应把框视作头部核心区域，
 *   头部高度 ≈ 框高 × 1.34，且框的下沿大致落在下巴附近。
 */
import type { FaceBox } from './face';

/** BlazeFace 框高 → 整个头部高度（发顶到下巴）的换算系数 */
const FACE_TO_HEAD = 1.34;
/** 框内从上沿到「发顶」的额外上延比例（相对框高） */
const BOX_TOP_TO_HAIR = 0.43;
/** 目标头部占画面高度的比例 */
const TARGET_HEAD_RATIO = 0.6;
/** 期望的头顶留白占画面高度比例 */
const TARGET_TOP_MARGIN = 0.1;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 计算裁切区域。
 *
 * @param srcW    原图宽
 * @param srcH    原图高
 * @param targetW 目标宽（像素）
 * @param targetH 目标高（像素）
 * @param face    人脸检测结果（归一化），null 时退化为中心裁切
 */
export function computeCropRect(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  face: FaceBox | null
): CropRect {
  const targetAspect = targetW / targetH;

  if (!face) {
    // 无人脸：按目标比例做中心裁切，构图重心略微上移
    const cropW = Math.min(srcW, srcH * targetAspect);
    const cropH = cropW / targetAspect;
    return {
      x: (srcW - cropW) / 2,
      y: Math.max(0, (srcH - cropH) * 0.3),
      width: cropW,
      height: cropH
    };
  }

  const boxTop = face.y * srcH;
  const boxH = face.height * srcH;
  const faceCenterX = (face.x + face.width / 2) * srcW;

  // 头部高度与发顶位置
  const headH = boxH * FACE_TO_HEAD;
  const headTop = boxTop - boxH * BOX_TOP_TO_HAIR;

  // 由「头部占比」反推画布高度
  let cropH = headH / TARGET_HEAD_RATIO;
  let cropW = cropH * targetAspect;

  // 画布不得超出原图
  if (cropW > srcW) {
    cropW = srcW;
    cropH = cropW / targetAspect;
  }
  if (cropH > srcH) {
    cropH = srcH;
    cropW = cropH * targetAspect;
  }

  // 水平：脸部中心居中
  let left = faceCenterX - cropW / 2;
  // 垂直：让头顶留白 = TARGET_TOP_MARGIN × cropH
  let top = headTop - TARGET_TOP_MARGIN * cropH;

  // 边界收敛
  left = Math.max(0, Math.min(left, srcW - cropW));
  top = Math.max(0, Math.min(top, srcH - cropH));

  return { x: left, y: top, width: cropW, height: cropH };
}

/** 把裁切区域限制在图像范围内并取整（至少 1px） */
export function clampRect(rect: CropRect, srcW: number, srcH: number): CropRect {
  const width = Math.max(1, Math.min(rect.width, srcW));
  const height = Math.max(1, Math.min(rect.height, srcH));
  const x = Math.max(0, Math.min(rect.x, srcW - width));
  const y = Math.max(0, Math.min(rect.y, srcH - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
