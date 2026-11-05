import { defineConfig } from 'vitest/config'
import { alias, include } from './vitest.config.ts'

// 真机配置：包含规则与测试别名都从主配置取，只把「排除 live.spec」这一条去掉。
// 早先靠 `sed '/exclude/d' vitest.config.ts` 现场拼一份临时配置，那会连带删掉
// 将来任何含 exclude 的行——换成这个固定文件，复跑就是一条命令。
export default defineConfig({
  resolve: { alias },
  test: { include },
})
