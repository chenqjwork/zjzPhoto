#!/usr/bin/env node
/**
 * 验收测试：在真实 Chromium 中逐条验证验收标准。
 *
 * 分两部分：
 *   A. 确定性部分（注入已知 alpha 掩膜，不依赖模型推理）
 *      —— 验证裁切、去污染、换底色、导出像素精确
 *   B. 真实推理部分（加载真实模型跑一张真实人像照）
 *      —— 验证抠图链路可用、无外部 CDN、切底色不重跑模型
 *
 * 运行：npm run build && npm run test:e2e
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'tests/__artifacts__');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });

const REAL_PHOTO = resolve(root, 'tests/__fixtures__/portrait.jpg');
const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!existsSync(resolve(root, 'dist/index.html'))) {
  console.error('未找到 dist/，请先运行 npm run build');
  process.exit(1);
}

const pickPort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });

let server = null;
const startServer = (port) => {
  const s = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  s.stdout.on('data', () => {});
  s.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  return s;
};
const cleanup = () => {
  try {
    server?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);

const waitForServer = async (base) => {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(base, { method: 'HEAD' });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

/* ------------------------------------------------------------- 注入用掩膜 */

/**
 * 生成一份「已知答案」的抠图结果：
 *   - 画布 600×800，竖直中轴线上一颗椭圆「头」+ 梯形「肩」
 *   - 原背景 = 纯白 (255,255,255)，用于验证去污染
 *   - 前景 = 深色 (40,40,40)，若不去污染，边缘会泛白
 *   - α 沿椭圆边界渐变，制造半透明边缘带
 */
const INJECTION_SCRIPT = `(() => {
  const W = 600, H = 800;
  const pixels = new Uint8ClampedArray(W * H * 4);
  const alpha = new Uint8Array(W * H);
  const BG = { r: 255, g: 255, b: 255 };   // 原背景（白墙）
  const FG = { r: 40, g: 40, b: 40 };      // 前景（深色头发/衣服）

  const headCx = W / 2, headCy = 250, headRx = 130, headRy = 165;
  const inHead = (x, y) => {
    const dx = (x - headCx) / headRx, dy = (y - headCy) / headRy;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const shoulderTop = 430;
  const shoulderHalf = (y) => 105 + (y - shoulderTop) * 0.55;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = inHead(x, y);
      const inShoulder = y >= shoulderTop && Math.abs(x - headCx) <= shoulderHalf(y);

      // α：椭圆内部为 1，边界外侧 0.90~1.15 之间从 1 渐变到 0
      // （刻意做宽，制造像发丝那样真正的半透明边缘，用于检验去污染）
      let a = 0;
      if (inShoulder) {
        const half = shoulderHalf(y);
        const dist = Math.abs(x - headCx);
        a = dist <= half - 14 ? 1 : Math.max(0, (half - dist) / 14);
      }
      if (d <= 1.15) {
        const edge = d <= 0.9 ? 1 : (1.15 - d) / 0.25;
        a = Math.max(a, Math.max(0, Math.min(1, edge)));
      }
      alpha[i] = Math.round(a * 255);

      // 观测像素 C = α·F + (1-α)·B  —— 模拟相机拍到的白墙边缘
      pixels[i * 4]     = Math.round(a * FG.r + (1 - a) * BG.r);
      pixels[i * 4 + 1] = Math.round(a * FG.g + (1 - a) * BG.g);
      pixels[i * 4 + 2] = Math.round(a * FG.b + (1 - a) * BG.b);
      pixels[i * 4 + 3] = 255;
    }
  }

  // 人脸框（归一化）：头部椭圆的外接框
  const face = {
    x: (headCx - headRx) / W,
    y: (headCy - headRy) / H,
    width: (headRx * 2) / W,
    height: (headRy * 2) / H,
    score: 0.99
  };

  window.__app.injectCutout({ width: W, height: H, pixels, alpha, sourceBackground: BG, face });
  return { W, H, face };
})()`;

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const port = Number(process.env.PORT) || (await pickPort());
  const BASE = `http://127.0.0.1:${port}`;
  server = startServer(port);
  if (!(await waitForServer(BASE))) throw new Error('预览服务启动失败');
  console.log(`预览服务就绪: ${BASE}\n`);

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

  /* ============ 验收4a：375px 首屏无横向滚动 ============ */
  {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth
    }));
    record('验收4a 375px 首屏无横向滚动', m.scrollW <= m.clientW + 1, `scrollWidth=${m.scrollW} clientWidth=${m.clientW}`);
    await ctx.close();
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err).slice(0, 200)));

  const externalHosts = new Set();
  let modelRequests = 0;
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalHosts.add(url.hostname);
    if (/\.(tflite|wasm)(\?|$)/.test(url.pathname)) modelRequests++;
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  /* ==================== A. 确定性测试（注入已知掩膜） ==================== */
  console.log('── A. 确定性验证（注入已知 alpha 掩膜）\n');
  const injected = await page.evaluate(INJECTION_SCRIPT);
  await page.waitForTimeout(300);
  record('注入抠图结果并渲染成功', !!injected.W, `${injected.W}×${injected.H}`);

  // 验收1：边缘无白边 —— 在白墙 + 红底场景下量化「亮像素残留」
  await page.click('.swatch[data-hex="#FF0000"]');
  await page.waitForTimeout(300);

  {
    const halo = await page.evaluate(() => {
      const canvas = document.getElementById('preview-canvas');
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let brightOnRed = 0;
      let reddish = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (r > 200 && g < 70 && b < 70) reddish++;
        // 红底上不该出现的「亮而中性」的像素 = 白边
        else if (lum > 150 && Math.abs(r - g) < 70) brightOnRed++;
      }
      return { brightOnRed, reddish, total: width * height };
    });
    record(
      '验收1 头发/边缘无明显白边（红底无亮色残留）',
      halo.brightOnRed === 0,
      `红底亮色残留 ${halo.brightOnRed} px；纯红底 ${halo.reddish} px / 共 ${halo.total} px`
    );
  }

  // 验证去污染强度的因果性：把去污染降到 0，白边应当重新出现
  {
    const setSlider = async (v) => {
      await page.$eval('#decontam', (el, val) => {
        el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
      await page.waitForTimeout(300);
    };
    // 度量方式：红底上「非纯红」像素的平均亮度。
    // 半透明边缘若未去污染，会把白色背景混进来 → 平均亮度显著偏高。
    const measureEdgeBrightness = () =>
      page.evaluate(() => {
        const canvas = document.getElementById('preview-canvas');
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        let n = 0;
        let strongHalo = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // 跳过纯色底与前景主体，只看「过渡带」
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const isPureRed = r > 245 && g < 25 && b < 25;
          const isDarkFg = lum < 40;
          if (isPureRed || isDarkFg) continue;
          sum += lum;
          n++;
          if (g > 110 && b > 110 && r > 200) strongHalo++; // 红底上的偏白像素
        }
        return { meanEdgeLum: n ? sum / n : 0, edgePixels: n, strongHalo };
      });

    await setSlider(0);
    const off = await measureEdgeBrightness();
    await setSlider(85);
    const on = await measureEdgeBrightness();
    record(
      '验收1b 去污染具有可观测的因果效果',
      off.meanEdgeLum > on.meanEdgeLum + 5 && on.strongHalo === 0,
      `过渡带平均亮度：关闭 ${off.meanEdgeLum.toFixed(1)} → 开启 ${on.meanEdgeLum.toFixed(1)}；` +
        `偏白像素：关闭 ${off.strongHalo} → 开启 ${on.strongHalo}`
    );
  }

  // 验收2：三色切换实时生效 + 色值精确 + 不重跑模型
  {
    const modelBefore = modelRequests;
    const samples = [];
    for (const hex of ['#FFFFFF', '#438EDB', '#FF0000']) {
      await page.click(`.swatch[data-hex="${hex}"]`);
      await page.waitForTimeout(250);
      const px = await page.evaluate(() => {
        const canvas = document.getElementById('preview-canvas');
        const d = canvas.getContext('2d').getImageData(1, 1, 1, 1).data;
        return [d[0], d[1], d[2]];
      });
      samples.push({ hex, px });
    }
    const expected = { '#FFFFFF': [255, 255, 255], '#438EDB': [67, 142, 219], '#FF0000': [255, 0, 0] };
    const allMatch = samples.every(({ hex, px }) => expected[hex].every((v, i) => Math.abs(v - px[i]) <= 2));
    record(
      '验收2a 白/蓝/红三色切换实时生效且色值准确',
      allMatch,
      samples.map((s) => `${s.hex}→rgb(${s.px.join(',')})`).join(' · ')
    );
    record(
      '验收2b 切换底色未重新加载模型',
      modelRequests === modelBefore,
      `模型/wasm 请求增量 = ${modelRequests - modelBefore}`
    );
  }

  // 自定义 Hex
  {
    await page.fill('#custom-hex', '#00A86B');
    await page.dispatchEvent('#custom-hex', 'change');
    await page.waitForTimeout(300);
    const px = await page.evaluate(() => {
      const c = document.getElementById('preview-canvas');
      const d = c.getContext('2d').getImageData(1, 1, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    record(
      '验收2c 自定义 Hex 生效',
      Math.abs(px[0]) <= 2 && Math.abs(px[1] - 168) <= 2 && Math.abs(px[2] - 107) <= 2,
      `#00A86B → rgb(${px.join(',')})`
    );
  }

  // 验收3：六种规格导出像素精确
  {
    await page.click('.swatch[data-hex="#438EDB"]');
    await page.waitForTimeout(200);
    const cases = [
      ['one-inch', 295, 413],
      ['small-one-inch', 260, 378],
      ['large-one-inch', 390, 567],
      ['two-inch', 413, 579],
      ['small-two-inch', 413, 531],
      ['large-two-inch', 413, 626]
    ];
    for (const [id, w, h] of cases) {
      await page.click(`.chip[data-size-id="${id}"]`);
      await page.waitForTimeout(200);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-png')]);
      const p = resolve(artifacts, `${id}.png`);
      await dl.saveAs(p);
      const dims = pngSize(p);
      record(`验收3 导出像素精确 ${id} = ${w}×${h}`, dims.width === w && dims.height === h, `实际 ${dims.width}×${dims.height}`);
      if (id === 'one-inch') {
        const dpi = pngDpi(p);
        record('验收3b PNG 写入 300dpi 元数据', dpi !== null && Math.abs(dpi - 300) <= 1, dpi ? `pHYs = ${dpi.toFixed(1)} dpi` : '未找到 pHYs 块');
      }
    }
  }

  // 相纸排版
  {
    await page.click('.chip[data-size-id="one-inch"]');
    await page.check('#sheet-toggle');
    await page.waitForTimeout(200);

    const captured = [];
    const onDownload = (d) => captured.push(d);
    page.on('download', onDownload);
    await page.click('#export-jpg');
    // 一次导出会产生两个下载（单张 + 相纸）
    for (let i = 0; i < 40 && captured.length < 2; i++) await page.waitForTimeout(500);
    page.off('download', onDownload);

    record('附加 勾选相纸后一次导出产生 2 个文件', captured.length === 2, `捕获到 ${captured.length} 个下载`);

    // 分别保存两个文件，用尺寸区分「单张」与「相纸」（相纸固定 1500×1050）
    let sheetPath = null;
    let singlePath = null;
    for (const [i, d] of captured.entries()) {
      const p = resolve(artifacts, `export-${i}.jpg`);
      await d.saveAs(p);
      const dims = jpegSize(p);
      if (dims.width === 1500 && dims.height === 1050) sheetPath = p;
      else if (dims.width === 295 && dims.height === 413) singlePath = p;
    }
    record('附加 单张导出为 295×413', !!singlePath, singlePath ? '已确认' : '未找到 295×413 的文件');
    record('附加 相纸排版尺寸 1500×1050', !!sheetPath, sheetPath ? '已确认' : '未找到 1500×1050 的文件');
    if (sheetPath) {
      const grid = await countSheetCells(sheetPath);
      record('附加 相纸排版 8 张（2 列 × 4 行，每格均有内容）', grid.filled === 8, `有内容的格子 ${grid.filled}/8`);
    }
    await page.uncheck('#sheet-toggle');
  }

  // 验收4b：375px 工作区无横向滚动
  {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const overflow = [];
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
          overflow.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`.slice(0, 40));
        }
      });
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, overflow: overflow.slice(0, 6) };
    });
    record(
      '验收4b 375px 工作区无横向滚动',
      m.scrollW <= m.clientW + 1,
      `scrollWidth=${m.scrollW} clientWidth=${m.clientW}${m.overflow.length ? ' 溢出: ' + m.overflow.join(',') : ''}`
    );
    await page.screenshot({ path: resolve(artifacts, 'mobile-375.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
  }

  /* ==================== B. 真实模型推理（真实人像照） ==================== */
  console.log('\n── B. 真实模型推理验证\n');
  if (existsSync(REAL_PHOTO)) {
    const p2 = await ctx.newPage();
    const extHosts2 = new Set();
    let modelReq2 = 0;
    const errs2 = [];
    p2.on('request', (req) => {
      const url = new URL(req.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) extHosts2.add(url.hostname);
      if (/\.(tflite|wasm)(\?|$)/.test(url.pathname)) modelReq2++;
    });
    p2.on('pageerror', (e) => errs2.push(String(e).slice(0, 200)));

    await p2.goto(BASE, { waitUntil: 'networkidle' });
    await p2.setInputFiles('#file-input', REAL_PHOTO);
    await p2.waitForSelector('#workspace:not(.hidden)', { timeout: 60000 });
    console.log('   已上传真实人像，等待本地推理…');

    let ok = true;
    try {
      await p2.waitForFunction(
        () => document.getElementById('status')?.classList.contains('hidden'),
        undefined,
        { timeout: 180000 }
      );
    } catch {
      ok = false;
      const msg = await p2.textContent('#status-text').catch(() => '');
      record('验收5 真实照片本地抠图成功', false, `状态: ${msg}`);
    }
    if (ok) {
      const stats = await p2.evaluate(() => {
        const c = document.getElementById('preview-canvas');
        const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        // 白底：统计非白像素比例，作为「是否抠出人像」的判据
        let person = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (Math.abs(255 - data[i]) + Math.abs(255 - data[i + 1]) + Math.abs(255 - data[i + 2]) > 45) person++;
        }
        return { ratio: person / (width * height), width, height };
      });
      record(
        '验收5 真实照片本地抠图成功',
        stats.ratio > 0.15 && stats.ratio < 0.95,
        `人像像素占比 ${(stats.ratio * 100).toFixed(1)}%（预览 ${stats.width}×${stats.height}）`
      );
      record(
        '验收5b 全部资源同源加载（无 Google CDN / 外部域名）',
        extHosts2.size === 0,
        extHosts2.size ? `外部域名: ${[...extHosts2].join(', ')}` : `已加载 ${modelReq2} 个模型/wasm 请求，全部同源`
      );

      // 切底色不重跑模型（真实推理场景）
      const before = modelReq2;
      for (const hex of ['#438EDB', '#FF0000', '#FFFFFF']) {
        await p2.click(`.swatch[data-hex="${hex}"]`);
        await p2.waitForTimeout(250);
      }
      record('验收5c 切底色未重跑模型（真实推理场景）', modelReq2 === before, `模型/wasm 请求增量 = ${modelReq2 - before}`);

      // 导出尺寸
      for (const hex of ['#438EDB']) {
        await p2.click(`.swatch[data-hex="${hex}"]`);
      }
      await p2.click('.chip[data-size-id="one-inch"]');
      await p2.waitForTimeout(300);
      const [dl] = await Promise.all([p2.waitForEvent('download', { timeout: 30000 }), p2.click('#export-png')]);
      const p = resolve(artifacts, 'real-one-inch.png');
      await dl.saveAs(p);
      const dims = pngSize(p);
      record('验收5d 真实照片导出一寸 = 295×413', dims.width === 295 && dims.height === 413, `实际 ${dims.width}×${dims.height}`);
      record('验收5e 真实推理无 JS 报错', errs2.length === 0, errs2.slice(0, 2).join(' | '));

      const frame = await p2.$('#preview-frame');
      await frame.screenshot({ path: resolve(artifacts, 'real-preview.png') });
    }
    await p2.close();
  } else {
    record('验收5 真实照片本地抠图成功', false, `缺少测试照片 ${REAL_PHOTO}`);
  }

  await page.screenshot({ path: resolve(artifacts, 'desktop.png'), fullPage: true });
  record('确定性测试无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await ctx.close();
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log('\n──────────────────────────────');
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  writeFileSync(resolve(artifacts, 'report.json'), JSON.stringify(results, null, 2));
  if (failed.length) {
    console.log('失败项:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------ 工具函数 */

/**
 * 读取 PNG 的 pHYs 块，换算成 dpi。
 * pHYs 数据为 9 字节：x ppm(4) + y ppm(4) + 单位(1)。
 */
function pngDpi(path) {
  const buf = readFileSync(path);
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'pHYs') {
      const xppm = buf.readUInt32BE(i + 8);
      const unit = buf[i + 16];
      if (unit !== 1) return null; // 非「米」单位
      return xppm * 0.0254;
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return null;
}

function pngSize(path) {
  const buf = readFileSync(path);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(path) {
  const buf = readFileSync(path);
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('无法解析 JPEG 尺寸');
}

/**
 * 检查相纸排版的 8 个格子是否都有照片内容。
 * 采用固定 2 列 × 4 行网格，统计每格中心的非白像素比例。
 * 需要浏览器解码 JPEG，因此用 Playwright 重新打开页面来读取像素。
 */
async function countSheetCells(jpgPath) {
  const b64 = readFileSync(jpgPath).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${b64}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const filled = await page.evaluate(
    async ({ url }) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const cols = 2;
      const rows = 4;
      let count = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // 在格子中心 40% 区域内统计非白像素
          const x0 = Math.floor((c + 0.3) * (cv.width / cols));
          const y0 = Math.floor((r + 0.3) * (cv.height / rows));
          const bw = Math.floor((cv.width / cols) * 0.4);
          const bh = Math.floor((cv.height / rows) * 0.4);
          const d = cx.getImageData(x0, y0, bw, bh).data;
          let nonWhite = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(255 - d[i]) + Math.abs(255 - d[i + 1]) + Math.abs(255 - d[i + 2]) > 60) nonWhite++;
          }
          if (nonWhite / (bw * bh) > 0.05) count++;
        }
      }
      return count;
    },
    { url: dataUrl }
  );
  await browser.close();
  return { filled };
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
