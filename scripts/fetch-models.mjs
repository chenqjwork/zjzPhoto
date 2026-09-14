#!/usr/bin/env node
/**
 * 下载本项目所需的全部模型 / WASM 资源到 public/ 目录，实现完全自托管。
 *
 * 为什么需要这个脚本：
 *   - 浏览器端推理的权重文件体积较大（合计约 12MB），不适合直接提交进 git 仓库；
 *   - 上游下载地址（Google / jsDelivr）在国内网络不可达，因此不能运行时远程加载，
 *     必须在构建阶段落地到 public/，由本站同源提供。
 *
 * 用法：
 *   npm run fetch:models            # 下载缺失或校验失败的文件
 *   npm run fetch:models -- --force # 强制重新下载
 *
 * 校验：每个文件都带 sha256，校验不通过会删除并报错，避免拿到被劫持/损坏的权重。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

/**
 * 资源清单
 * - dir:  相对仓库根的落地路径
 * - sha256: 官方发布文件的校验值
 * - mirror: 备用镜像（jsDelivr，仅作加速/容灾，主源仍是官方地址）
 */
const ASSETS = [
  {
    // MediaPipe Tasks Vision 的 WASM 运行时（face / image 任务共用）
    // 与 npm 包 @mediapipe/tasks-vision@0.10.20/wasm 内容一致
    url: 'https://storage.googleapis.com/mediapipe-models/wasm/vision_wasm_internal.wasm',
    mirror: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm/vision_wasm_internal.wasm',
    file: 'public/wasm/vision_wasm_internal.wasm',
    sha256: 'f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7'
  },
  {
    mirror: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm/vision_wasm_nosimd_internal.wasm',
    file: 'public/wasm/vision_wasm_nosimd_internal.wasm',
    sha256: '3821ea9b1f7fb8c549ef2a064ef5c85750bf375c545a49fd6eea0df44a95f1f4'
  },
  {
    // FilesetResolver 会先 fetch 这个 JS 加载器，再由它 locateFile 到上面的 .wasm
    // 缺少它会在 forVisionTasks() 阶段直接 404 失败
    mirror: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm/vision_wasm_internal.js',
    file: 'public/wasm/vision_wasm_internal.js',
    sha256: '4a97e2520ba506c680ecd6ba6acfb146888afa0e2746d57f205352bc6ebb82eb'
  },
  {
    mirror: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm/vision_wasm_nosimd_internal.js',
    file: 'public/wasm/vision_wasm_nosimd_internal.js',
    sha256: '927def7b465c51b86e4b3060f93646aca4e27121f4b8fc0483786e407ea9cf1f'
  },
  {
    // 人脸检测：BlazeFace short-range，用于自动人脸居中裁切
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    file: 'public/models/blaze_face_short_range.tflite',
    sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f'
  },
  {
    // 人像抠图：MediaPipe ImageSegmenter 的 selfie_multiclass 模型（256x256，float32）
    //
    // 注意：不要用 image_segmenter/selfie_segmenter 那个 244KB 的模型。
    // 它属于旧的 MLKit SelfieSegmentation（输出 conv2d_31/BiasAdd，无 /model/ 层名），
    // MediaPipe Tasks 的 ImageSegmenter 读不了：categoryMask 会全为 255、
    // confidenceMasks 只有 1 个且几乎全 0，表现为「抠不出人像」。
    // selfie_multiclass 是 Tasks 官方模型，输出 6 类（0 背景 + 5 类人像部位）。
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite',
    file: 'public/models/selfie_multiclass_256x256.tflite',
    sha256: 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0'
  }
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function verify(file, hash) {
  const abs = resolve(root, file);
  if (!(await exists(abs))) return false;
  return sha256(await readFile(abs)) === hash;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  let failed = 0;

  for (const asset of ASSETS) {
    const abs = resolve(root, asset.file);
    console.log(`\n── ${asset.file}`);
    console.log(`   来源: ${asset.url ?? asset.mirror}`);

    if (!force && (await verify(asset.file, asset.sha256))) {
      console.log('   状态: 已存在且校验通过，跳过');
      continue;
    }

    await mkdir(dirname(abs), { recursive: true });

    const sources = [asset.url, asset.mirror].filter(Boolean);
    let buf = null;
    for (const src of sources) {
      try {
        console.log(`   下载: ${src}`);
        buf = await download(src);
        if (sha256(buf) === asset.sha256) break;
        console.warn('   校验失败，尝试下一个源');
        buf = null;
      } catch (err) {
        console.warn(`   失败: ${err.message}`);
      }
    }

    if (!buf) {
      failed++;
      console.error('   错误: 所有源均不可用或校验不通过');
      console.error('   提示: 可手动下载该文件放到上述路径，文件名需一致');
      continue;
    }

    await writeFile(abs, buf);
    console.log(`   完成: ${(buf.length / 1024 / 1024).toFixed(2)} MB，sha256 校验通过`);
  }

  if (failed > 0) {
    console.error(`\n有 ${failed} 个文件下载失败，请检查网络后重试（或手动放置到 public/ 对应路径）`);
    process.exit(1);
  }
  console.log('\n全部模型资源就绪 ✅');
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
