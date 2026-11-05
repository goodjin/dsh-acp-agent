import { describe, expect, it } from 'vitest'
import { DEFAULT_QODER_ENDPOINTS, qoderIdentityHeaders, resolveEndpoints } from '../src/qoder/endpoints.ts'

describe('Qoder 国际版的端点', () => {
  it('四个默认端点来自同一套国际版 prod 环境', () => {
    const e = resolveEndpoints({})
    expect(e.loginBase).toBe('https://qoder.com')
    expect(e.openapiBase).toBe('https://openapi.qoder.sh')
    expect(e.centerBase).toBe('https://center.qoder.sh')
    expect(e.catalogBase).toBe('https://api3.qoder.sh')
    expect(e.modelBase).toBe('https://api2-v2.qoder.sh')
  })

  it('每一处地址都由它自己的基址派生', () => {
    const e = resolveEndpoints({})
    expect(e.pollUrl).toBe('https://openapi.qoder.sh/api/v1/deviceToken/poll')
    expect(e.refreshUrl).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
    expect(e.accountUrl).toBe('https://center.qoder.sh/api/v1/userinfo')
    expect(e.modelListUrl).toBe('https://api3.qoder.sh/api/v2/model/list?Encode=1')
    expect(e.chatUrl).toBe('https://api2-v2.qoder.sh/model/v1/chat/completions')
  })

  it('环境变量可以逐个换掉端点，换过的那个自己派生地址', () => {
    const e = resolveEndpoints({ QODER_MODEL_BASE: 'https://model.example.com/' })
    expect(e.modelBase).toBe('https://model.example.com')
    expect(e.chatUrl).toBe('https://model.example.com/model/v1/chat/completions')
    expect(e.pollUrl).toContain('openapi.qoder.sh')
  })

  it('默认常量就是解析出来的这一套', () => {
    expect(resolveEndpoints({})).toEqual(DEFAULT_QODER_ENDPOINTS)
  })

  it('身份头带上客户端类型与机器', () => {
    const headers = qoderIdentityHeaders('1.2.3')
    expect(headers['Cosy-Version']).toBe('1.2.3')
    expect(headers['Cosy-ClientType']).toBe('5')
    expect(headers['Cosy-MachineOS']).toMatch(/_(darwin|linux|win32)$/)
  })
})
