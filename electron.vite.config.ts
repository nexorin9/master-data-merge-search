import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const r = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/**
 * 三段构建：main（主进程）/ preload（白名单通道）/ renderer（评审台界面）。
 * 入口与源仓库同款，桌面常驻形态下的主入口是 Electron 应用本身。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(r('./src/main/index.ts')) },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(r('./src/preload/index.ts')) },
      },
    },
  },
  renderer: {
    root: r('./src/renderer'),
    resolve: {
      alias: {
        '@renderer': r('./src/renderer'),
        '@shared': r('./src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(r('./src/renderer/index.html')) },
      },
    },
    plugins: [vue()],
  },
})
