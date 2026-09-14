/**
 * 人脸检测：MediaPipe FaceDetector（BlazeFace short-range）。
 * 用于自动人脸居中与头部占比裁切。
 */
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { assetUrl } from './segment';

export interface FaceBox {
  /** 归一化坐标 0..1 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 置信度 */
  score: number;
}

let detectorPromise: Promise<FaceDetector> | null = null;

export function getFaceDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(assetUrl('./wasm'));
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: assetUrl('./models/blaze_face_short_range.tflite'),
          delegate: 'GPU'
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.4
      });
    })().catch((err) => {
      detectorPromise = null;
      throw err;
    });
  }
  return detectorPromise;
}

/** 检测画面中面积最大的人脸（证件照通常只有一张脸） */
export async function detectLargestFace(
  source: ImageBitmap | HTMLCanvasElement
): Promise<FaceBox | null> {
  const detector = await getFaceDetector();
  const result = detector.detect(source);
  const detections = result.detections ?? [];

  if (detections.length === 0) return null;

  let best: FaceBox | null = null;
  let bestArea = 0;
  for (const det of detections) {
    const box = det.boundingBox;
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const area = box.width * box.height;
    if (area > bestArea) {
      bestArea = area;
      best = {
        x: box.originX / source.width,
        y: box.originY / source.height,
        width: box.width / source.width,
        height: box.height / source.height,
        score: det.categories?.[0]?.score ?? 0
      };
    }
  }
  return best;
}
