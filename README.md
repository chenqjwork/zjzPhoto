# 证件照工坊

纯前端证件照制作工具。上传照片 → 浏览器本地抠图 → 一键换底色 → 按规范尺寸导出。
**照片全程不上传服务器**，没有后端、没有账号、没有埋点。

面向需要报名 / 入职证件照的国内用户，手机和 PC 都能用。

## 功能

- **本地抠图**：MediaPipe ImageSegmenter 在浏览器内运行，照片不出设备
- **一键换底色**：白底 `#FFFFFF` / 蓝底 `#438EDB` / 红底 `#FF0000`，并支持任意 Hex 自定义
- **六种规格预设**（均为 300dpi 像素，导出像素精确等于所选规格）：

  | 规格 | 像素 | 物理尺寸 |
  | --- | --- | --- |
  | 一寸 | 295×413 | 25×35mm |
  | 小一寸 | 260×378 | 22×32mm |
  | 大一寸 | 390×567 | 33×48mm |
  | 二寸 | 413×579 | 35×49mm |
  | 小二寸 | 413×531 | 35×45mm |
  | 大二寸 | 413×626 | 35×53mm |

- **自动人脸居中裁切**：MediaPipe FaceDetector 定位人脸，人脸居中 + 头顶留白约 10% + 头部占画面高约 60%
- **颜色去污染**：按 `F = (C - (1-α)·B) / α` 反解半透明边缘像素，消除换底色后的白边
- **相纸排版**：可选导出一张 5 寸相纸 `1500×1050`，排版 8 张一寸照，带裁切定位线
- **导出 JPG / PNG**：PNG 会写入 300dpi 的 `pHYs` 块，冲印店可直接按物理尺寸输出
- **抠图结果缓存**：切换底色 / 规格只做像素合成，不会重新跑模型

## 快速开始

```bash
npm install
npm run fetch:models   # 下载模型与 WASM 到 public/（必须执行一次）
npm run dev            # 开发预览 http://localhost:5173
npm run build          # 生产构建（含 tsc 类型检查）
npm run preview        # 预览构建产物
```

> `npm run dev` / `vite` 启动时会自动做一次资源自检：若 `public/wasm` 或
> `public/models` 里没有文件，会直接报错并提示执行 `npm run fetch:models`，
> 不会带着一个「一上传照片就 404」的服务继续跑。
> 需要跳过自检（例如 CI 中资源由别处提供）时设置环境变量 `SKIP_ASSET_CHECK=1`。

### 报 `vision_wasm_internal.js 404` 怎么办

若页面加载后上传照片失败，控制台出现：

```
GET http://localhost:5173/wasm/vision_wasm_internal.js  404 Not Found
```

说明 **自托管资源没下载**（这是最常见的原因，不是代码 bug）：

- 模型 / WASM 合计约 25MB，**没有提交进 git**（见 `.gitignore` 里的 `public/wasm/*`、
  `public/models/*`），所以 clone 后必须跑一次 `npm run fetch:models`；
- 缺文件时 MediaPipe 会去 fetch 那个 JS 加载器，而 Vite / 大多数静态托管会把
  找不到的路径 **回退成 `index.html`（200 或 404 都可能是回退页）**，
  真正的错误信息因此被掩盖。

修复步骤：

```bash
npm run fetch:models    # 下载 + sha256 校验
npm run verify:assets   # 只校验不下载，确认 6 个文件全部到位
```

本项目已内置防护，正常情况下不会让你看到这个 404：

1. `npm run dev` / `vite` 启动前自检 —— 缺文件直接启动失败并给出提示（`vite.config.ts`）；
2. 页面侧 `src/segment.ts` 的 `ensureAssets()` —— 上传照片前先 `HEAD` 探测关键资源，
   缺失时在界面上显示「请执行 `npm run fetch:models`」而不是笼统的「处理失败，请重试」。
   探测用 `HEAD` 并额外检查 `content-type`，因此 SPA fallback 返回的 HTML 不会被误判成文件存在。

### 为什么点「选择照片」要点两次

**已修复**。现象：首次点击弹出系统文件框后立刻自动关闭，必须再点一次。

成因是 DOM 结构 + 事件冒泡：`#pick-btn` 位于 `#dropzone` 内部，而两者当时都各自
监听 `click` 并调用 `fileInput.click()`。一次真实点击会依次触发两个 handler：

1. 按钮自己的 handler → `fileInput.click()`（弹窗打开）
2. 事件冒泡到 `#dropzone` → 又一次 `fileInput.click()`（弹窗被立即取消）

修复方式是把「打开文件框」收敛为单一入口 `App.openPicker()`，
并让按钮 / 换图按钮的 handler 调用 `e.stopPropagation()`，不再与拖拽区的
委托 handler 叠加。顺带补上了拖拽区（`role="button" tabindex="0"`）缺失的
Enter / Space 键盘支持。

`tests/e2e.mjs` 中有三条回归断言，分别对按钮、拖拽区、键盘 Enter 校验
`fileInput.click()` 恰好被调用 **1 次** —— 这类「多绑定一次」的 bug 不会在
功能测试里暴露（功能最终仍可用），所以必须显式计数。


## 模型文件必须自托管

**运行时不访问任何外部 CDN**（Google / jsDelivr 在国内均不可用），
所有模型与 WASM 都由本站从 `public/` 同源提供。

这些文件体积较大（合计约 12MB），不适合提交进 git 仓库，因此需要先下载：

```bash
npm run fetch:models          # 下载缺失或校验失败的文件
npm run fetch:models -- --force   # 强制重新下载
```

脚本会从上游地址下载到以下位置，**并逐个校验 sha256**（校验失败会报错，避免用到损坏或被替换的权重）：

| 落地路径 | 用途 | 大小 |
| --- | --- | --- |
| `public/wasm/vision_wasm_internal.js` | MediaPipe 运行时加载器 | ~200KB |
| `public/wasm/vision_wasm_internal.wasm` | MediaPipe 运行时（SIMD） | ~9.1MB |
| `public/wasm/vision_wasm_nosimd_internal.js` | 运行时加载器（无 SIMD 回退） | ~200KB |
| `public/wasm/vision_wasm_nosimd_internal.wasm` | 运行时（无 SIMD 回退） | ~9.0MB |
| `public/models/blaze_face_short_range.tflite` | 人脸检测 | ~224KB |
| `public/models/selfie_multiclass_256x256.tflite` | 人像抠图 | ~15.6MB |

<details>
<summary>手动下载（网络受限时）</summary>

按上表把文件放到对应路径，文件名必须一致：

- WASM 运行时：`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm/<文件名>`
- BlazeFace：`https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`
- selfie_multiclass：`https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`

放好后运行 `npm run fetch:models` 可校验是否完整。
</details>

### ⚠️ 不要用 `selfie_segmenter.tflite`

`image_segmenter/selfie_segmenter`（244KB）属于旧的 MLKit `SelfieSegmentation`，
输出张量名是 `conv2d_31/BiasAdd` 且没有 `/model/` 层名。
MediaPipe **Tasks** 版 `ImageSegmenter` 读不了它，实测表现为：

- `categoryMask` 全为 `255`
- `confidenceMasks` 只有 1 个（而不是 6 个）且几乎全 0

也就是「完全抠不出人像」。请使用 `selfie_multiclass_256x256`，它输出 6 类：

```
0 背景 · 1 头发 · 2 身体皮肤 · 3 面部皮肤 · 4 衣服 · 5 配饰
```

## 技术选型理由

### 抠图：MediaPipe ImageSegmenter（而非 `@imgly/background-removal` / ISNet）

| | MediaPipe selfie_multiclass | @imgly/background-removal (ISNet) |
| --- | --- | --- |
| 许可证 | **Apache-2.0**，可自由商用 | **AGPL-3.0**，商用需向 IMG.LY 购买授权 |
| 模型体积 | 15.6MB | 44MB ~ 176MB |
| 模型来源 | Google 官方地址，可自托管 | 仅 `staticimgly.com`，国内不通 |
| 额外依赖 | 无（与 FaceDetector 共用一套 WASM） | 需 `onnxruntime-web`（+23MB WASM） |

选 MediaPipe 的两条硬理由：

1. **许可证**：`@imgly/background-removal` 的 `LICENSE.md` 是 AGPL-3.0，README 明确写
   "free for use under the AGPL License, contact support@img.ly for other licensing options"。
   本项目是面向公众的工具站，走 AGPL 对使用者不友好。
2. **依赖收敛**：人脸检测本来就要用 `@mediapipe/tasks-vision`，
   抠图复用同一套运行时即可，不必再引入 `onnxruntime-web`。

ISNet 的发丝级精度确实更好，本项目用两条手段补偿：

- `src/refine.ts`：α 掩膜做形态学闭运算（填内部空洞 + 平滑锯齿）+ 温和模糊 + 边缘带对比度拉伸
- `src/color.ts`：边缘像素做颜色去污染，消除原背景残留

> 注：本仓库的默认分支上，最初的需求提到「抠图用 `@imgly/background-removal` 或 MediaPipe
> ImageSegmenter，二选一并说明理由」。上面即为选型说明；作者在 Issue 中同步过这一决策。

### 人脸检测：MediaPipe FaceDetector

`blaze_face_short_range`，与抠图同库同运行时。
注意 BlazeFace 输出的是**近似正方形的「整个头部」框**（不是只有五官的脸），
因此 `src/crop.ts` 用 `FACE_TO_HEAD = 1.34` 换算头部高度，并从框上沿往上推发顶位置。

## 颜色去污染是怎么做的

抠图后每个像素是前景 `F` 与原背景 `B` 按 α 的混合：

```
C = α·F + (1-α)·B
```

如果换底色时直接 `Out = α·C + (1-α)·G`，边缘就会把原背景色 `B` 带进新底色 ——
白墙照片换红底时表现为一圈**白边 / 白晕**。

正确做法是先反解前景，再与目标色合成：

```
F   = (C - (1-α)·B) / α     ← 去污染
Out = α·F + (1-α)·G         ← 换底色
```

实现要点（`src/color.ts`）：

- **原背景色 `B` 是估出来的**：取图像四边各 2% 宽的边缘带，只统计 `α < 32` 的像素，
  按 r/g/b 分别取**中位数**（抗离群，比均值稳）
- **α 下限保护**：`α < 0.05` 时不再反解（除以极小值会产生彩噪）
- **结果钳制到 [0,255]**，防止反解溢出
- **去污染强度可调**（界面滑块 0~100%），便于对比效果

## 开发与测试

```bash
npm run typecheck    # tsc --noEmit
npm run build        # 类型检查 + 生产构建
npm run test:unit     # 单元测试：去污染数学 + 资源自检（不需要浏览器）
npm run verify:assets # 只校验模型/WASM 是否齐全（不下载）
npm run test:e2e      # 端到端验收测试（需要 build + Playwright）
```

### 测试策略

验收测试分两部分（`tests/e2e.mjs`）：

**A. 确定性验证** —— 注入一份「已知答案」的 alpha 掩膜，完全绕开模型推理，
因此结果**可复现、不受模型版本影响**，用于验证：

- 边缘白边量化（红底上无亮色残留）
- 去污染的因果关系（关闭去污染 → 过渡带平均亮度从 62.7 升到 83.4）
- 三色切换色值精确、自定义 Hex 生效
- 六种规格导出像素精确相等
- 一次导出产生「单张 + 相纸」两个文件，相纸 `1500×1050` 且 8 格均有内容
- 375px 下无横向滚动（含逐元素溢出扫描）
- **选择照片只触发一次系统文件框**：按钮 / 拖拽区 / 键盘 Enter 三个入口
  各断言只调用 1 次 `fileInput.click()`（回归防护，见下方「已知限制」）

**B. 真实模型推理** —— 用一张真实人像照跑完整链路：

- 抠图成功且人像占比合理
- 全部资源同源加载（断言外部域名请求数为 0）
- 切换底色时模型 / WASM 请求增量为 0
- 导出一寸为 `295×413`

`tests/unit-decontam.mjs` 还从源码层面断言去污染公式确实存在，
并做数值验证（复现「不去污染会偏白」这一现象）。

`tests/unit-assets.mjs` 覆盖「模型没下载」这条最常见的故障路径（16 项）：

- 资源齐全时自检放行；缺 wasm / 缺模型 / 真 404 / `200 + text/html` 回退页时均能拦截
- 网络异常不会误判成文件缺失；失败后可重试（修好文件刷新即恢复）
- 子路径部署时 URL 基于 `document.baseURI` 解析
- 源码层面断言 `ensureAssets()` 已接入 `segment.ts` / `face.ts` / `app.ts`，
  且 `vite.config.ts` 启动自检、`package.json` 提供 `verify:assets`
- `fetch-models.mjs --verify-only` 的真实退出码行为

首次运行需要安装浏览器：

```bash
npx playwright install chromium
```

## 项目结构

```
src/
  main.ts        入口，能力检测 + 启动
  app.ts         主流程编排、界面交互、导出
  segment.ts     人像抠图（MediaPipe ImageSegmenter + selfie_multiclass）
  face.ts        人脸检测（MediaPipe FaceDetector）
  crop.ts        自动人脸居中裁切（头部占比 / 头顶留白）
  refine.ts      α 掩膜边缘精修（闭运算 + 模糊 + 对比度拉伸）
  color.ts       颜色解析 + 颜色去污染 + 换底色合成
  image.ts       读图 / 缩放 / 相纸排版 / 导出 / PNG 300dpi 元数据
  presets.ts     尺寸规格与底色预设
  style.css      样式（移动优先）
scripts/
  fetch-models.mjs   下载并校验自托管模型
tests/
  unit-decontam.mjs  去污染数学单元测试
  unit-assets.mjs    自托管资源自检的单元测试（404 故障路径）
  e2e.mjs            端到端验收测试
  __fixtures__/      测试用真人照片
```

## 浏览器支持

需要 WebAssembly + `createImageBitmap`：Chrome / Edge 90+、Firefox 90+、Safari 15+。
不支持时页面会给出明确提示。

抠图优先使用 GPU（WebGPU/WebGL）推理，不可用时自动回退到 WASM。
首次抠图需要加载约 12MB 模型，之后走浏览器缓存。

## 已知限制

- 抠图模型在 256×256 上推理，超大图会先缩到长边 2000px 再处理
- 「颜色去污染」依赖对原背景色的估计，若背景极其杂乱（如树林），
  估计出的 `B` 会不准，此时建议把界面上的去污染强度调低
- 导出的 JPG 不写入 DPI 元数据（JPEG 的 DPI 需写 APP0/JFIF 段）；
  需要精确物理尺寸时请导出 PNG

## 许可证

本项目代码采用 MIT。

第三方资源：

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) — Apache-2.0
- [selfie_multiclass_256x256](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) 模型 — Apache-2.0
- [BlazeFace short-range](https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector) 模型 — Apache-2.0
