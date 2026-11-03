import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // 浏览器专用包在 node 里装不上（缺 clsx 等运行时依赖），要测浏览器模块就得
    // 把这个入口指到测试替身。构建产物仍用真件，别名只作用于测试。
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': new URL('./tests/support/primitives-stub.tsx', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/live.spec.ts'],
  },
})
