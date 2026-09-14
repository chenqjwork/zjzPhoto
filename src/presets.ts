/**
 * 证件照规格与底色预设。
 *
 * 尺寸均为 300dpi 下的像素值，来源于国内常见证件照标准：
 *   物理尺寸 = 像素 / 300 (英寸)
 *   一寸 295×413 ≈ 25×35mm
 */

export interface SizePreset {
  /** 预设标识 */
  id: string;
  /** 中文名称 */
  name: string;
  /** 宽度（像素，300dpi） */
  width: number;
  /** 高度（像素，300dpi） */
  height: number;
  /** 换算出的物理尺寸，用于界面提示 */
  physical: string;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: 'one-inch', name: '一寸', width: 295, height: 413, physical: '25×35mm' },
  { id: 'small-one-inch', name: '小一寸', width: 260, height: 378, physical: '22×32mm' },
  { id: 'large-one-inch', name: '大一寸', width: 390, height: 567, physical: '33×48mm' },
  { id: 'two-inch', name: '二寸', width: 413, height: 579, physical: '35×49mm' },
  { id: 'small-two-inch', name: '小二寸', width: 413, height: 531, physical: '35×45mm' },
  { id: 'large-two-inch', name: '大二寸', width: 413, height: 626, physical: '35×53mm' }
];

export interface BackgroundPreset {
  id: string;
  name: string;
  hex: string;
}

/** 证件照标准色值 */
export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: 'white', name: '白底', hex: '#FFFFFF' },
  { id: 'blue', name: '蓝底', hex: '#438EDB' },
  { id: 'red', name: '红底', hex: '#FF0000' }
];

export const DEFAULT_SIZE_ID = 'one-inch';
export const DEFAULT_BACKGROUND_HEX = '#FFFFFF';

/**
 * 相纸排版规格：5 寸相纸 1500×1050（300dpi 下 5×3.5 英寸，横向）
 */
export const SHEET = {
  name: '5 寸相纸',
  width: 1500,
  height: 1050,
  physical: '127×89mm'
} as const;

/** 相纸上按该规格排版时的目标张数 */
export const SHEET_COUNT = 8;

export const findSizePreset = (id: string): SizePreset =>
  SIZE_PRESETS.find((p) => p.id === id) ?? SIZE_PRESETS[0];
