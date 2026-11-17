import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const r = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/**
 * 截图 harness 专用构建：把真实 App.vue + 真实数据打成静态 SPA，
 * 供 headless Chrome 以固定视口渲染为实测截图。不是产品构建路径，
 * 仅用于采集 docs/screenshots/ 的真机渲染证据。
 */
export default defineConfig({
  root: r('./scripts/shots'),
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@core': r('./src/core'),
      '@renderer': r('./src/renderer'),
    },
  },
  plugins: [vue()],
  build: {
    outDir: r('./.shots-build'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(r('./scripts/shots/index.html')) } },
  },
})
