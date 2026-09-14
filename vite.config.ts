import { defineConfig } from 'vite';

/**
 * 使用相对 base，让产物可以直接挂在任意子路径下（CNB 预览 / 静态托管均可）。
 * 模型与 WASM 通过 ./models / ./wasm 相对路径加载，因此不依赖绝对路径。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    // 模型文件体积较大，关闭内联告警
    chunkSizeWarningLimit: 2048
  },
  server: {
    host: true,
    port: 5173
  },
  preview: {
    host: true,
    port: 4173
  }
});
