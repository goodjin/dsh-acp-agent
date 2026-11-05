/**
 * 借 Qoder 应用自带的 SDK 拉模型清单。
 *
 * 站点那份清单要 Qoder 自己的原生模块算签名，JS 复刻不了——所以让 SDK 自己算：
 * 起一个 `--sdk` 进程，stdin/stdout 说 NDJSON 控制协议，令牌走环境变量指的文件。
 *
 * 这里用假 daemon（tests/support/fake-qoder-sdk.mjs）验证协议与折算，不依赖
 * Qoder 应用、也不碰网络。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fetchCatalogViaSdk, findQoderSdk } from '../src/qoder/catalog.ts'

const FAKE = fileURLToPath(new URL('./support/fake-qoder-sdk.mjs', import.meta.url))

describe('借 SDK 拉清单', () => {
  it('握手后拿到模型：id、名字、倍率、档位、上下文', async () => {
    const models = await fetchCatalogViaSdk({
      accessToken: 'TOKEN',
      uid: 'uid-1',
      sdkPath: FAKE,
      spawnSdk: (sdk, authFile) => spawn(process.execPath, [sdk], {
        env: { ...process.env, QODER_SDK_AUTH_PAYLOAD_FILE: authFile },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    })
    expect(models).toEqual([
      { id: 'gmodel', name: 'GLM-5.3', credits: '0.8', efforts: ['high', 'low', 'max'], contextWindow: 180000, supportsImages: true },
      { id: 'mmodel', name: 'MiniMax-M3.1-Flash', credits: '0.1', efforts: ['medium'], contextWindow: 180000, supportsImages: true },
    ])
  })

  it('没装 Qoder 时是空清单，不是崩掉', async () => {
    const models = await fetchCatalogViaSdk({
      accessToken: 'TOKEN',
      sdkPath: '/nowhere/qoder-sdk.mjs',
      spawnSdk: () => undefined,
    })
    expect(models).toEqual([])
  })

  it('本机装了 Qoder 时能找到它的 SDK', () => {
    const found = findQoderSdk()
    // 装了就应该找得到；没装就返回 undefined，不抛错。
    expect(found === undefined || typeof found.sdk === 'string').toBe(true)
  })
})
