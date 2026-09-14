/**
 * 证件照工坊 —— 主流程编排与界面交互。
 *
 * 数据流：
 *   文件 → ImageBitmap → 一次性 人脸检测 + 抠图 + α 精修 + 缓存
 *        → 用户切换底色/尺寸 → 裁切 → 合成 → 预览 / 导出
 *
 * 「一次性」是关键：抠图结果缓存在内存，切底色只做像素合成，不重跑模型。
 */
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_HEX,
  DEFAULT_SIZE_ID,
  SHEET,
  SHEET_COUNT,
  SIZE_PRESETS,
  findSizePreset,
  type SizePreset
} from './presets';
import { applyBackground, estimateBackgroundColor, parseHex, toHex, type Rgb } from './color';
import { detectLargestFace, type FaceBox } from './face';
import { computeCropRect, clampRect } from './crop';
import { refineAlpha } from './refine';
import { ensureAssets, segmentPerson } from './segment';
import {
  canvasToBlob,
  composeSheet,
  downscaleIfNeeded,
  downloadBlob,
  loadPhoto,
  readPixels,
  withPngDpi,
  type LoadedPhoto
} from './image';

interface Cutout {
  width: number;
  height: number;
  /** 原图 RGBA，未被修改 */
  pixels: Uint8ClampedArray;
  /** 精修后的 alpha */
  alpha: Uint8Array;
  /** 估算的原背景色，去污染用 */
  sourceBackground: Rgb;
  face: FaceBox | null;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

/**
 * 测试专用钩子：允许验收脚本注入一份「已知的抠图结果」，
 * 从而在完全不依赖模型推理的前提下，验证裁切 / 去污染 / 换底色 / 导出像素。
 * 生产环境不会调用。
 */
export interface InjectedCutout {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  alpha: Uint8Array;
  sourceBackground: Rgb;
  face: FaceBox | null;
}

export class App {
  private photo: LoadedPhoto | null = null;
  private cutout: Cutout | null = null;
  private sizeId = DEFAULT_SIZE_ID;
  private bgHex = DEFAULT_BACKGROUND_HEX;
  private decontamStrength = 0.85;
  private busy = false;
  private previewMaxEdge = 900;

  private readonly dropzone = $('dropzone');
  private readonly fileInput = $<HTMLInputElement>('file-input');
  private readonly pickBtn = $<HTMLButtonElement>('pick-btn');
  private readonly changeBtn = $<HTMLButtonElement>('change-btn');
  private readonly workspace = $('workspace');
  private readonly canvas = $<HTMLCanvasElement>('preview-canvas');
  private readonly status = $('status');
  private readonly statusText = $('status-text');
  private readonly progressWrap = $('progress-wrap');
  private readonly progressBar = $('progress-bar');
  private readonly sizeList = $('size-list');
  private readonly bgList = $('bg-list');
  private readonly customColor = $<HTMLInputElement>('custom-color');
  private readonly customHex = $<HTMLInputElement>('custom-hex');
  private readonly headline = $('preview-headline');
  private readonly subline = $('preview-subline');
  private readonly exportPanel = $('export-panel');
  private readonly quality = $<HTMLInputElement>('quality');
  private readonly sheetToggle = $<HTMLInputElement>('sheet-toggle');
  private readonly decontam = $<HTMLInputElement>('decontam');
  private readonly decontamValue = $('decontam-value');
  private readonly exportJpg = $<HTMLButtonElement>('export-jpg');
  private readonly exportPng = $<HTMLButtonElement>('export-png');
  private readonly previewNote = $('preview-note');

  /** 测试专用：注入抠图结果（见 InjectedCutout 说明） */
  injectCutout(cutout: InjectedCutout): void {
    this.cutout = cutout;
    this.el_showWorkspace();
    this.compose();
  }

  private el_showWorkspace(): void {
    this.dropzone.classList.add('hidden');
    this.workspace.classList.remove('hidden');
    this.exportPanel.classList.remove('hidden');
    this.previewNote.textContent = '（测试注入）';
  }

  constructor() {
    this.renderSizeOptions();
    this.renderBackgroundOptions();
    this.bind();
    this.updateDecontamLabel();
    this.updateSubline();
    this.syncQualityLabel();
  }

  /* -------------------------------------------------------------- 初始化 */

  /**
   * 打开系统文件选择框。
   *
   * 注意：`#pick-btn` 位于 `#dropzone` 内部，两处都监听 click 会让一次点击
   * 触发两次 `fileInput.click()` —— 系统弹窗刚打开就被第二次调用取消，
   * 表现为「首次弹出后自动隐藏，必须再点一次」。因此这里统一收敛为
   * 单一入口，并由按钮的 handler 阻止冒泡。
   */
  private openPicker(): void {
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private bind(): void {
    // 同一动作只绑定一次：阻止冒泡，避免与 dropzone 的委托 handler 叠加
    this.pickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPicker();
    });
    this.changeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPicker();
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.handleFile(file);
    });

    const dz = this.dropzone;
    dz.addEventListener('click', () => this.openPicker());
    // dropzone 带 role="button" 与 tabindex，键盘操作需与鼠标等价
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        this.openPicker();
      }
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('is-dragging');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('is-dragging');
      })
    );
    dz.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.handleFile(file);
    });

    window.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const item = items.find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) void this.handleFile(file);
    });

    this.decontam.addEventListener('input', () => {
      this.decontamStrength = Number(this.decontam.value) / 100;
      this.updateDecontamLabel();
      this.compose();
    });
    this.quality.addEventListener('input', () => this.syncQualityLabel());
    this.sheetToggle.addEventListener('change', () => this.updateSubline());

    this.customColor.addEventListener('input', () => {
      this.bgHex = this.customColor.value.toUpperCase();
      this.customHex.value = this.bgHex;
      this.syncBackgroundSelection();
      this.compose();
    });
    this.customHex.addEventListener('change', () => {
      const parsed = parseHex(this.customHex.value);
      if (!parsed) {
        this.customHex.value = this.bgHex;
        return;
      }
      this.bgHex = toHex(parsed);
      this.customColor.value = this.bgHex;
      this.syncBackgroundSelection();
      this.compose();
    });

    this.exportJpg.addEventListener('click', () => void this.export('image/jpeg'));
    this.exportPng.addEventListener('click', () => void this.export('image/png'));
    window.addEventListener('beforeunload', () => {
      if (this.photo) URL.revokeObjectURL(this.photo.objectUrl);
    });
  }

  private renderSizeOptions(): void {
    const nodes = SIZE_PRESETS.map((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.dataset.sizeId = preset.id;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(preset.id === this.sizeId));

      const title = document.createElement('span');
      title.className = 'chip-title';
      title.textContent = preset.name;

      const meta = document.createElement('span');
      meta.className = 'chip-meta';
      meta.textContent = `${preset.width}×${preset.height}`;

      btn.append(title, meta);
      btn.addEventListener('click', () => {
        this.sizeId = preset.id;
        this.syncSizeSelection();
        this.compose();
      });
      return btn;
    });
    this.sizeList.replaceChildren(...nodes);
    this.syncSizeSelection();
  }

  private syncSizeSelection(): void {
    this.sizeList.querySelectorAll<HTMLButtonElement>('.chip').forEach((btn) => {
      const active = btn.dataset.sizeId === this.sizeId;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  private renderBackgroundOptions(): void {
    const nodes: HTMLElement[] = BACKGROUND_PRESETS.map((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch';
      btn.dataset.hex = preset.hex;
      btn.setAttribute('role', 'radio');
      btn.title = `${preset.name} ${preset.hex}`;

      const dot = document.createElement('span');
      dot.className = 'swatch-dot';
      dot.style.setProperty('--swatch', preset.hex);

      const name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = preset.name;

      btn.append(dot, name);
      btn.addEventListener('click', () => {
        this.bgHex = preset.hex;
        this.customColor.value = preset.hex;
        this.customHex.value = preset.hex;
        this.syncBackgroundSelection();
        this.compose();
      });
      return btn;
    });

    const custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'swatch swatch-custom';
    custom.dataset.hex = '__custom__';
    custom.setAttribute('role', 'radio');
    custom.title = '自定义颜色';
    const cdot = document.createElement('span');
    cdot.className = 'swatch-dot swatch-dot-custom';
    const cname = document.createElement('span');
    cname.className = 'swatch-name';
    cname.textContent = '自定义';
    custom.append(cdot, cname);
    custom.addEventListener('click', () => this.customColor.click());
    nodes.push(custom);

    this.bgList.replaceChildren(...nodes);
    this.syncBackgroundSelection();
  }

  private syncBackgroundSelection(): void {
    const isCustom = !BACKGROUND_PRESETS.some((p) => p.hex.toUpperCase() === this.bgHex);
    this.bgList.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) => {
      const hex = btn.dataset.hex ?? '';
      const active = hex === '__custom__' ? isCustom : hex.toUpperCase() === this.bgHex;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  private updateDecontamLabel(): void {
    this.decontamValue.textContent = `${Math.round(this.decontamStrength * 100)}%`;
  }

  private syncQualityLabel(): void {
    const out = this.quality.parentElement?.querySelector('output');
    if (out) out.textContent = `${Math.round(Number(this.quality.value) * 100)}%`;
  }

  /* ---------------------------------------------------------------- 状态 */

  private setStatus(text: string, kind: 'info' | 'error' | 'none' = 'info'): void {
    this.statusText.textContent = text;
    this.status.classList.toggle('hidden', kind === 'none');
    this.status.classList.toggle('is-error', kind === 'error');
  }

  private setProgress(ratio: number | null): void {
    if (ratio === null) {
      this.progressWrap.classList.add('hidden');
      this.progressBar.style.width = '0%';
      return;
    }
    this.progressWrap.classList.remove('hidden');
    this.progressBar.style.width = `${Math.round(ratio * 100)}%`;
  }

  /* ------------------------------------------------------------ 核心流程 */

  private async handleFile(file: File): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setButtonsDisabled(true);
    try {
      this.setStatus('正在读取照片…');
      this.setProgress(0.05);

      // 先自检自托管资源，缺文件时直接给出「执行 npm run fetch:models」的提示，
      // 而不是让 MediaPipe 抛出难以定位的 404（见 segment.ts ensureAssets）
      await ensureAssets();

      if (this.photo) URL.revokeObjectURL(this.photo.objectUrl);
      this.photo = await loadPhoto(file);
      this.cutout = null;

      this.dropzone.classList.add('hidden');
      this.workspace.classList.remove('hidden');
      this.exportPanel.classList.remove('hidden');
      this.previewNote.textContent = `${this.photo.name} · ${this.photo.width}×${this.photo.height}`;

      await this.runCutout();
      this.compose();
      this.setStatus('抠图完成，可随时切换底色与规格', 'none');
    } catch (err) {
      console.error(err);
      this.setStatus(err instanceof Error ? err.message : '处理失败，请重试', 'error');
    } finally {
      this.setProgress(null);
      this.busy = false;
      this.setButtonsDisabled(false);
    }
  }

  private setButtonsDisabled(disabled: boolean): void {
    this.exportJpg.disabled = disabled;
    this.exportPng.disabled = disabled;
    this.changeBtn.disabled = disabled;
  }

  /** 一次性完成：缩放 → 人脸检测 → 抠图 → α 精修 → 缓存 */
  private async runCutout(): Promise<void> {
    if (!this.photo) return;

    this.setStatus('准备图像…');
    this.setProgress(0.15);
    const { source, width, height } = await downscaleIfNeeded(this.photo);

    this.setStatus('检测人脸…');
    this.setProgress(0.3);
    let face: Cutout['face'] = null;
    try {
      face = await detectLargestFace(source);
    } catch (err) {
      console.warn('人脸检测失败，改用中心裁切', err);
    }

    this.setProgress(0.45);
    const rawAlpha = await segmentPerson(source, (msg) => this.setStatus(msg));
    this.setProgress(0.8);

    this.setStatus('优化边缘…');
    const refined = refineAlpha(rawAlpha, width, height);
    this.setProgress(0.9);

    const imageData = readPixels(source);
    const sourceBackground = estimateBackgroundColor(imageData.data, width, height, refined);

    this.cutout = {
      width,
      height,
      pixels: new Uint8ClampedArray(imageData.data),
      alpha: refined,
      sourceBackground,
      face
    };

    if (source !== this.photo.bitmap) source.close();
    this.setProgress(1);
  }

  /** 按当前「规格 + 底色」重新合成预览（不触发模型推理） */
  private compose(): void {
    if (!this.cutout) return;
    const preset = findSizePreset(this.sizeId);
    const bg = parseHex(this.bgHex) ?? { r: 255, g: 255, b: 255 };
    const full = this.renderFull(preset, bg);
    this.paintPreview(full, preset);
    this.updateHeadline(preset);
  }

  /** 渲染目标规格的全尺寸画布（像素精确等于规格） */
  private renderFull(preset: SizePreset, bg: Rgb): HTMLCanvasElement {
    const cutout = this.cutout;
    if (!cutout) throw new Error('尚未完成抠图');

    const composed = document.createElement('canvas');
    composed.width = cutout.width;
    composed.height = cutout.height;
    const cctx = composed.getContext('2d');
    if (!cctx) throw new Error('当前浏览器不支持 Canvas 2D');

    const pixels = new Uint8ClampedArray(cutout.pixels);
    applyBackground(pixels, cutout.alpha, cutout.width, cutout.height, {
      background: bg,
      sourceBackground: cutout.sourceBackground,
      strength: this.decontamStrength
    });
    cctx.putImageData(new ImageData(pixels, cutout.width, cutout.height), 0, 0);

    const rect = clampRect(
      computeCropRect(cutout.width, cutout.height, preset.width, preset.height, cutout.face),
      cutout.width,
      cutout.height
    );

    const out = document.createElement('canvas');
    out.width = preset.width;
    out.height = preset.height;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('当前浏览器不支持 Canvas 2D');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(
      composed,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      preset.width,
      preset.height
    );
    return out;
  }

  private paintPreview(full: HTMLCanvasElement, preset: SizePreset): void {
    const scale = Math.min(1, this.previewMaxEdge / Math.max(preset.width, preset.height));
    const w = Math.max(1, Math.round(preset.width * scale));
    const h = Math.max(1, Math.round(preset.height * scale));

    const canvas = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  }

  private updateHeadline(preset: SizePreset): void {
    this.headline.textContent = `${preset.name} · ${preset.width}×${preset.height}`;
    this.updateSubline();
  }

  private updateSubline(): void {
    const preset = findSizePreset(this.sizeId);
    const parts = [`${preset.physical} · 300dpi`, `底色 ${this.bgHex}`];
    if (this.sheetToggle.checked) {
      parts.push(`另存 ${SHEET.name} 排版 ${SHEET_COUNT} 张`);
    }
    this.subline.textContent = parts.join(' · ');
  }

  /* -------------------------------------------------------------- 导出 */

  private async export(format: 'image/jpeg' | 'image/png'): Promise<void> {
    if (!this.cutout || this.busy) return;
    this.busy = true;
    this.setButtonsDisabled(true);
    const preset = findSizePreset(this.sizeId);
    const bg = parseHex(this.bgHex) ?? { r: 255, g: 255, b: 255 };

    try {
      this.setStatus('正在导出…');
      this.setProgress(0.5);
      const full = this.renderFull(preset, bg);
      const ext = format === 'image/jpeg' ? 'jpg' : 'png';
      const quality = Number(this.quality.value);
      const base = `证件照_${preset.name}_${preset.width}x${preset.height}_${this.bgHex.replace('#', '')}`;

      // PNG 额外写入 300dpi 的 pHYs 块，冲印店可直接按物理尺寸输出
      const toOut = async (canvas: HTMLCanvasElement) => {
        const blob = await canvasToBlob(canvas, format, format === 'image/jpeg' ? quality : undefined);
        return format === 'image/png' ? withPngDpi(blob, 300) : blob;
      };

      downloadBlob(await toOut(full), `${base}_300dpi.${ext}`);

      if (this.sheetToggle.checked) {
        this.setProgress(0.8);
        const sheet = composeSheet(full, SHEET.width, SHEET.height, SHEET_COUNT);
        downloadBlob(
          await toOut(sheet),
          `${base}_相纸${SHEET.width}x${SHEET.height}_${SHEET_COUNT}张_300dpi.${ext}`
        );
      }

      this.setProgress(1);
      this.setStatus('导出完成，请查看浏览器下载目录', 'none');
    } catch (err) {
      console.error(err);
      this.setStatus(err instanceof Error ? err.message : '导出失败', 'error');
    } finally {
      this.setProgress(null);
      this.busy = false;
      this.setButtonsDisabled(false);
    }
  }
}
