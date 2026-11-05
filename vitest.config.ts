import { defineConfig } from 'vitest/config'

/** 套件收哪些测试文件。真机配置（vitest.live.config.ts）复用这一份，别两处各写 */
export const include = ['tests/**/*.spec.ts']

/** 真机套件要真二进制、要联网、还慢，默认挡在门禁外 */
export const exclude = ['tests/live.spec.ts']

// 浏览器专用包在 node 里装不上（缺 clsx 等运行时依赖），要测浏览器模块就得
// 把这个入口指到测试替身。构建产物仍用真件，别名只作用于测试。
export const alias = {
  '@deepseek-ai/dsh-client-ui-primitives': new URL('./tests/support/primitives-stub.tsx', import.meta.url).pathname,
}

export default defineConfig({
  resolve: { alias },
  test: { include, exclude },
})
