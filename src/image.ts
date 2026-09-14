/**
 * 图像工具：文件读取、缩放、导出、相纸排版。
 * 全部在浏览器本地完成，不上传任何数据。
 */

export interface LoadedPhoto {
  /** 原始位图，用于反复抠图/裁切 */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** 原始文件信息 */
  name: string;
  type: string;
  size: number;
  /** 预览用 objectURL，释放时调用 revoke */
  objectUrl: string;
}

/** 读取用户选择的图片文件 */
export async function loadPhoto(file: File): Promise<LoadedPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择 JPG / PNG 等图片文件');
  }
  const bitmap = await createImageBitmap(file);
  if (bitmap.width < 64 || bitmap.height < 64) {
    bitmap.close();
    throw new Error('图片太小，请上传清晰的人像照片');
  }
  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    name: file.name,
    type: file.type,
    size: file.size,
    objectUrl: URL.createObjectURL(file)
  };
}

/** 读取整张图片的 RGBA 像素 */
export function readPixels(source: ImageBitmap | HTMLCanvasElement): ImageData {
  const width = source.width;
  const height = source.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * 在保留前景质量的前提下把大图缩到可控尺寸。
 * 抠图模型固定 256×256 推理，输入过大只会白耗内存，这里设一个上限。
 */
export async function downscaleIfNeeded(
  photo: LoadedPhoto,
  maxEdge = 2000
): Promise<{ source: ImageBitmap; width: number; height: number; scaled: boolean }> {
  const longest = Math.max(photo.width, photo.height);
  if (longest <= maxEdge) {
    return { source: photo.bitmap, width: photo.width, height: photo.height, scaled: false };
  }
  const ratio = maxEdge / longest;
  const width = Math.round(photo.width * ratio);
  const height = Math.round(photo.height * ratio);
  const bitmap = await createImageBitmap(photo.bitmap, 0, 0, photo.width, photo.height, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high'
  });
  return { source: bitmap, width, height, scaled: true };
}

export interface RenderOptions {
  width: number;
  height: number;
}

/** 把 canvas 转成 Blob */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'image/jpeg' | 'image/png',
  quality = 0.95
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('导出失败，请重试'))),
      format,
      quality
    );
  });
}

/**
 * 把 PNG 的 pHYs 块改写为 300dpi，让冲印店/Photoshop 读出正确的物理尺寸。
 *
 * PNG 结构：[8 字节签名] 然后若干 chunk（length[4] + type[4] + data + crc[4]）。
 * pHYs 的数据是 9 字节：x 像素/米(4) + y 像素/米(4) + 单位(1，1=米)。
 * 300 dpi = 300 / 0.0254 ≈ 11811 像素/米。
 *
 * 若原图为 JPEG（canvas 导出的 JPEG 不带 DPI），则无法在此层写入，
 * 由界面文案说明「像素精确等于规格」即可。
 */
export async function withPngDpi(blob: Blob, dpi = 300): Promise<Blob> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);

  // 认 PNG 签名，否则原样返回
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 || !signature.every((b, i) => buf[i] === b)) return blob;

  const chunks: Uint8Array[] = [];
  let offset = 8;
  let inserted = false;

  const readU32 = (p: number) =>
    ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;

  while (offset + 12 <= buf.length) {
    const len = readU32(offset);
    const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
    const total = 12 + len;

    if (type === 'pHYs') {
      // 已有 pHYs：替换为 300dpi
      chunks.push(makeChunk('pHYs', pngPhysData(ppm)));
      inserted = true;
    } else {
      chunks.push(buf.subarray(offset, offset + total));
      if (type === 'IHDR' && !inserted) {
        // IHDR 之后必须紧跟（或尽早出现）pHYs
        chunks.push(makeChunk('pHYs', pngPhysData(ppm)));
        inserted = true;
      }
    }
    offset += total;
    if (type === 'IEND') break;
  }

  if (!inserted) return blob;

  const outParts = [buf.subarray(0, 8), ...chunks];
  const totalLen = outParts.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const c of outParts) {
    out.set(c, p);
    p += c.length;
  }
  return new Blob([out], { type: 'image/png' });
}

function pngPhysData(ppm: number): Uint8Array {
  const d = new Uint8Array(9);
  d[0] = (ppm >>> 24) & 0xff;
  d[1] = (ppm >>> 16) & 0xff;
  d[2] = (ppm >>> 8) & 0xff;
  d[3] = ppm & 0xff;
  d[4] = d[0];
  d[5] = d[1];
  d[6] = d[2];
  d[7] = d[3];
  d[8] = 1; // 单位为米
  return d;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间发起下载
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 5 寸相纸排版：把单张证件照复制 8 份，带裁切线。
 *
 * 布局：
 *   - 相纸 1500×1050（300dpi 5×3.5 英寸）
 *   - 2 列 × 4 行，每格居中放置一张证件照
 *   - 格与格之间、纸边留白，并绘制浅灰裁切定位线
 */
export function composeSheet(
  photo: HTMLCanvasElement,
  sheetWidth: number,
  sheetHeight: number,
  count = 8
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sheetWidth;
  canvas.height = sheetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, sheetWidth, sheetHeight);

  const cols = count <= 4 ? 1 : 2;
  const rows = Math.ceil(count / cols);

  const gapX = Math.round(sheetWidth * 0.045);
  const gapY = Math.round(sheetHeight * 0.04);
  const padX = Math.round(sheetWidth * 0.05);
  const padY = Math.round(sheetHeight * 0.05);

  // 单元格尺寸按可用空间等比计算，保证整张照片都放得下
  const cellW = (sheetWidth - padX * 2 - gapX * (cols - 1)) / cols;
  const cellH = (sheetHeight - padY * 2 - gapY * (rows - 1)) / rows;
  const scale = Math.min(cellW / photo.width, cellH / photo.height);
  const drawW = Math.max(1, Math.floor(photo.width * scale));
  const drawH = Math.max(1, Math.floor(photo.height * scale));

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = padX + col * (cellW + gapX);
    const cellY = padY + row * (cellH + gapY);

    const x = Math.round(cellX + (cellW - drawW) / 2);
    const y = Math.round(cellY + (cellH - drawH) / 2);

    ctx.drawImage(photo, 0, 0, photo.width, photo.height, x, y, drawW, drawH);

    // 裁切定位线：四角短线 + 边框，便于手工裁切
    drawCropMarks(ctx, x, y, drawW, drawH);
  }

  return canvas;
}

/** 绘制浅灰裁切定位标记 */
function drawCropMarks(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const len = Math.max(12, Math.round(Math.min(w, h) * 0.08));
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  ctx.beginPath();
  // 四角直角标记
  const corners: [number, number, number, number][] = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1]
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.moveTo(cx, cy + dy * len);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * len, cy);
  }
  ctx.stroke();

  // 外框虚线，方便对位
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}
