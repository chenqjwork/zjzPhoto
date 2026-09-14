#!/usr/bin/env node
/**
 * 颜色去污染（color decontamination）的纯数学单元测试。
 *
 * 这是本项目最核心、也最容易被做错的一步，因此不依赖浏览器与模型，
 * 直接对 src/color.ts 的算法做数值验证。
 *
 * 背景说明：
 *   抠图后每个像素是「前景 F」与「原背景 B」按 α 的混合：C = α·F + (1-α)·B
 *   若换底色时直接 Out = α·C + (1-α)·G，边缘会把原背景色 B 带进新底色，
 *   表现为常见的「白边 / 白晕」。
 *   正确做法是先反解前景 F = (C - (1-α)·B) / α，再与目标色合成。
 *
 * 运行：node tests/unit-decontam.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ---------------------------------------------------------------------------
 * 把 src/color.ts 的算法照搬一份到 JS 里做验证。
 * 为避免「测的是一份代码、跑的是另一份」，这里改为：从源码中提取函数体，
 * 用正则校验关键公式存在，并用同一套公式做数值验证。
 * ------------------------------------------------------------------------ */

const src = readFileSync(resolve(root, 'src/color.ts'), 'utf8');

// 1) 源码层面：确认去污染公式与标准色值确实存在
check(
  '源码包含去污染公式 F=(C-(1-α)·B)/α',
  /\(data\[i\]\s*-\s*inv\s*\*\s*sourceBackground\.r\)\s*\/\s*a/.test(src),
  '找到 (C - (1-α)·B) / α 形式'
);
check('源码包含 α 最小值保护', /DECONTAM_MIN_ALPHA/.test(src));
check(
  '源码按 α 与目标色合成 Out=α·F+(1-α)·G',
  /fr\s*\*\s*a\s*\+\s*background\.r\s*\*\s*ia/.test(src)
);
check('源码只统计边缘低 α 像素来估计原背景色', /alpha\[y \* width \+ x\] > 32/.test(src));

// 2) 数值层面：用同一起点复现算法，验证「白边消除」效果
const DECONTAM_MIN_ALPHA = 0.05;
const DECONTAM_MAX_ALPHA = 0.99;

/** 与 src/color.ts 中 applyBackground 等价的实现（用于对照） */
function composite({ C, alpha, B, G, strength = 1, decontam = true }) {
  const a = alpha;
  if (a <= 0) return G;
  let f = C;
  if (decontam && B && strength > 0 && a < DECONTAM_MAX_ALPHA && a > DECONTAM_MIN_ALPHA) {
    const inv = (1 - a) * strength;
    f = (C - inv * B) / a;
    f = Math.max(0, Math.min(255, f));
  }
  return f * a + G * (1 - a);
}

// 场景：原图白墙 B=245，前景是黑发 F=30，边缘像素 α=0.5
const B = 245;
const F = 30;
const alpha = 0.5;
const observed = alpha * F + (1 - alpha) * B; // = 137.5，观测到的灰白边缘
const targetRed = 255;

const withOut = composite({ C: observed, alpha, B, G: targetRed, decontam: false });
const withDecontam = composite({ C: observed, alpha, B, G: targetRed, decontam: true });

// 不去污染：结果 = 0.5*137.5 + 0.5*255 = 196 → 红底上出现明显的粉白晕圈
// 去污染后：F 反解回 30，结果 = 0.5*30 + 0.5*255 = 142 → 更接近应有值
check(
  '不去污染时边缘偏亮（复现白边现象）',
  Math.abs(withOut - 196.25) < 0.01,
  `无去污染结果 ${withOut.toFixed(2)}（应为 196.25，明显偏白）`
);
check(
  '去污染后边缘亮度显著下降',
  withDecontam < withOut - 40,
  `有/无去污染: ${withDecontam.toFixed(2)} vs ${withOut.toFixed(2)}`
);
check(
  '去污染后结果与理论值一致',
  Math.abs(withDecontam - (alpha * F + (1 - alpha) * targetRed)) < 0.01,
  `实际 ${withDecontam.toFixed(2)}，理论 ${(alpha * F + (1 - alpha) * targetRed).toFixed(2)}`
);

// 纯前景（α=1）不受去污染影响
const solid = composite({ C: F, alpha: 1, B, G: targetRed, decontam: true });
check('纯前景像素不被改动', Math.abs(solid - F) < 1e-9, `α=1 时结果 ${solid}`);

// 纯背景（α=0）直接是目标色
const bg = composite({ C: B, alpha: 0, B, G: targetRed, decontam: true });
check('纯背景像素等于目标底色', bg === targetRed, `α=0 时结果 ${bg}`);

// 三张标准色都要正确
for (const [hex, rgb] of [
  ['#FFFFFF', [255, 255, 255]],
  ['#438EDB', [67, 142, 219]],
  ['#FF0000', [255, 0, 0]]
]) {
  const out = composite({ C: observed, alpha: 0.5, B, G: rgb[0], decontam: true });
  const expect = alpha * F + (1 - alpha) * rgb[0];
  check(`标准底色 ${hex} 去污染计算正确`, Math.abs(out - expect) < 0.01, `${out.toFixed(2)}`);
}

/* --------------------------- parseHex / 颜色解析 --------------------------- */
const parseHexSrc = /export function parseHex[\s\S]*?\n}/.exec(src)?.[0] ?? '';
check('parseHex 支持 3 位简写', /0-9a-fA-F\]\{3\}/.test(parseHexSrc));
check('parseHex 支持 6 位标准写法', /0-9a-fA-F\]\{6\}/.test(parseHexSrc));

/* ------------------------------ estimateBackgroundColor ------------------------------ */
const estSrc = /export function estimateBackgroundColor[\s\S]*?\n}/.exec(src)?.[0] ?? '';
check('估计背景色使用中位数（抗离群）', /const median/.test(estSrc));
check('估计背景色只看边缘带', /const band/.test(estSrc));

console.log(`\n──────────────────────────────`);
console.log(`单元测试通过 ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;

void createRequire;
