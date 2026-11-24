/**
 * GLM 网关的模型清单接口：地址拼法与封套解析。
 *
 * 实测（2026-11-24，researcher-refresh）：`GET {base}/v1/models` 回 HTTP 200 的
 * camelCase 封套 `{data, firstId, hasMore, lastId}`，每条 `{id, display_name,
 * type, created_at}`；错误也回 200（`{code, msg, success:false}`），所以解析
 * 不能只看状态码。上游 id 小写、声明清单大写——大小写合并归刷新模块管，这里
 * 只如实转发网关的写法。密钥永不落错误文本。
 */

import { describe, expect, it } from 'vitest'
import { fetchGlmModels, modelsUrl, parseGlmModels } from '../src/zcode/models.ts'

/** 真机应答的形状（截取三条；字段一字不差）。 */
const ENVELOPE = {
  data: [
    { id: 'glm-4.5', display_name: 'GLM-4.5', type: 'model', created_at: 1 },
    { id: 'glm-5.3', display_name: 'GLM-5.3', type: 'model', created_at: 2 },
    { id: 'glm-5.4', display_name: 'GLM-5.4', type: 'model', created_at: 3 },
  ],
  firstId: 'glm-4.5',
  hasMore: false,
  lastId: 'glm-5.4',
}

type Call = { url: string; method?: string; headers: Record<string, unknown> }

/** 记录请求的假 fetch；应答固定 JSON。 */
function fakeFetch(body: unknown, status = 200): typeof fetch & { calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, unknown>,
    })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch & { calls: Call[] }
  impl.calls = calls
  return impl
}

/** 测试密钥（长度 ≥8，scrub 才会生效）。 */
const KEY = 'test-key-0123456789'
const KEY_REQUEST = { apiKey: KEY, endpoint: 'https://open.bigmodel.cn/api/anthropic' } as const

describe('modelsUrl', () => {
  it('从编码套餐 base 拼出 /v1/models（不是 origin 根）', () => {
    expect(modelsUrl('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn/api/anthropic/v1/models')
  })

  it('messages URL 也折回同一地址', () => {
    expect(modelsUrl('https://open.bigmodel.cn/api/anthropic/v1/messages')).toBe('https://open.bigmodel.cn/api/anthropic/v1/models')
  })
})

describe('parseGlmModels', () => {
  it('读 camelCase 封套，name 取 display_name，保序', () => {
    const models = parseGlmModels(ENVELOPE)
    expect(models.map(model => model.id)).toEqual(['glm-4.5', 'glm-5.3', 'glm-5.4'])
    expect(models[2]?.name).toBe('GLM-5.4')
  })

  it('没有 display_name 时用 id 兜底；displayName 也认', () => {
    expect(parseGlmModels({ data: [{ id: 'glm-9.9' }] })[0]).toEqual({ id: 'glm-9.9', name: 'glm-9.9' })
    expect(parseGlmModels({ data: [{ id: 'glm-9.9', displayName: 'GLM-9.9' }] })[0]?.name).toBe('GLM-9.9')
  })

  it('大小写无关去重，留第一条', () => {
    const models = parseGlmModels({ data: [{ id: 'glm-5.4', display_name: 'A' }, { id: 'GLM-5.4', display_name: 'B' }] })
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('A')
  })

  it('没有 id 的条目跳过，不把整份清单判死', () => {
    const models = parseGlmModels({ data: [{ display_name: 'ghost' }, { id: 'glm-5.4', display_name: 'GLM-5.4' }] })
    expect(models.map(model => model.id)).toEqual(['glm-5.4'])
  })

  it('网关错误封套（success:false）抛出 msg——HTTP 200 不代表成功', () => {
    expect(() => parseGlmModels({ code: 500, msg: '404 NOT_FOUND', success: false }))
      .toThrow('GLM models request failed: 404 NOT_FOUND')
  })

  it('没有 data 清单的形状判死', () => {
    expect(() => parseGlmModels({ ok: true })).toThrow('no data list')
    expect(() => parseGlmModels('str')).toThrow('not a JSON object')
  })
})

describe('fetchGlmModels', () => {
  it('GET 到 base 的 /v1/models，双头认证（x-api-key + Bearer）', async () => {
    const impl = fakeFetch(ENVELOPE)
    const models = await fetchGlmModels({ ...KEY_REQUEST, fetchImpl: impl })
    expect(models).toHaveLength(3)
    expect(impl.calls[0]?.url).toBe('https://open.bigmodel.cn/api/anthropic/v1/models')
    expect(impl.calls[0]?.method).toBe('GET')
    expect(impl.calls[0]?.headers['x-api-key']).toBe(KEY)
    expect(impl.calls[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  it('非 2xx 折成带状态码的错误', async () => {
    const impl = fakeFetch('gateway exploded', 502)
    await expect(fetchGlmModels({ ...KEY_REQUEST, fetchImpl: impl }))
      .rejects.toThrow('GLM models request failed (502)')
  })

  it('空清单当失败——「没拿到」必须与「拿到」可区分', async () => {
    const impl = fakeFetch({ data: [] })
    await expect(fetchGlmModels({ ...KEY_REQUEST, fetchImpl: impl }))
      .rejects.toThrow('listed no models')
  })

  it('非 JSON 应答折成错误，不裸抛', async () => {
    const impl = (async () => new Response('<html>bad</html>', { status: 200 })) as unknown as typeof fetch
    await expect(fetchGlmModels({ ...KEY_REQUEST, fetchImpl: impl }))
      .rejects.toThrow('was not JSON')
  })

  it('200 + 错误封套当失败，msg 进错误文本', async () => {
    const impl = fakeFetch({ code: 500, msg: '404 NOT_FOUND', success: false })
    await expect(fetchGlmModels({ ...KEY_REQUEST, fetchImpl: impl }))
      .rejects.toThrow('404 NOT_FOUND')
  })

  it('没有任何凭据时错误指明去哪登录（文件路径，不含密钥）', async () => {
    const impl = fakeFetch(ENVELOPE)
    await expect(fetchGlmModels({
      fetchImpl: impl,
      configFile: '/nonexistent/zcode/config.json',
      credentialsFile: '/nonexistent/zcode/credentials.json',
    })).rejects.toThrow(/no coding-plan api key.*Sign in to ZCode/s)
  })
})
