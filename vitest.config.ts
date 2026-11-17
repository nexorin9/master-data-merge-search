import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

const r = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/**
 * 单元 / 契约测试不依赖 Electron 运行时：node 环境即可跑。
 * 渲染层组件测试单独指定 jsdom 环境。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@core': r('./src/core'),
      '@main': r('./src/main'),
      '@renderer': r('./src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    reporters: ['default'],
  },
})
