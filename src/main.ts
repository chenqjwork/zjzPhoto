import './style.css';
import { App } from './app';
import { isSupported } from './segment';

function boot(): void {
  const fatal = document.getElementById('fatal');

  if (!isSupported()) {
    fatal?.classList.remove('hidden');
    if (fatal) {
      fatal.textContent =
        '当前浏览器不支持 WebAssembly / createImageBitmap，无法本地抠图。请使用最新版 Chrome、Edge、Safari 或 Firefox。';
    }
    return;
  }

  try {
    const app = new App();
    // 暴露给验收脚本使用（无副作用，生产环境也可安全存在）
    (window as unknown as Record<string, unknown>).__app = app;
  } catch (err) {
    console.error(err);
    if (fatal) {
      fatal.classList.remove('hidden');
      fatal.textContent = err instanceof Error ? err.message : '初始化失败';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
