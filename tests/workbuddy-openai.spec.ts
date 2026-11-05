/**
 * WorkBuddy 的端点解析与 OpenAI 请求体构造。
 *
 * 端点这一层钉三件事：默认落在官方外网站；环境变量能整体换站；**登录站与模型站
 * 必须同源**（两边从一个基址派生，不是各写各的——不同源就是登录成功但模型请求
 * 401，这种错最难查）。
 *
 * 请求体这一层钉的是 DSH 消息到 OpenAI chat 消息的投影：系统消息提到最前、相邻
 * 用户消息合并、工具调用进 `tool_calls`、工具结果进 `tool` 消息、**推理块不重放**
 * （OpenAI 侧不需要推理签名，重放反而可能被拒）、图片按模型是否支持视觉分别处理。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKBUDDY_BASE, resolveEndpoints } from '../src/workbuddy/endpoints.ts'
import { buildChatBody, resolveReasoningEffort } from '../src/workbuddy/openai.ts'

describe('端点解析', () => {
  it('默认落在官方外网站', () => {
    const endpoints = resolveEndpoints(undefined, {})
    expect(endpoints.base).toBe(DEFAULT_WORKBUDDY_BASE)
    expect(endpoints.chatUrl).toBe('https://www.workbuddy.cn/v2/chat/completions')
    expect(endpoints.configUrl).toBe('https://www.workbuddy.cn/v3/config')
    expect(endpoints.authStateUrl).toBe('https://www.workbuddy.cn/v2/plugin/auth/state')
    expect(endpoints.authTokenUrl).toBe('https://www.workbuddy.cn/v2/plugin/auth/token')
    expect(endpoints.authRefreshUrl).toBe('https://www.workbuddy.cn/v2/plugin/auth/token/refresh')
    expect(endpoints.accountUrl).toBe('https://www.workbuddy.cn/v2/plugin/account')
    expect(endpoints.checkinStatusUrl).toBe('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status')
    expect(endpoints.dailyCheckinUrl).toBe('https://www.workbuddy.cn/v2/billing/meter/daily-checkin')
    expect(endpoints.creditsUrl).toBe('https://www.workbuddy.cn/billing/meter/get-user-resource-summary')
  })

  it('环境变量能整体换站，且登录站与模型站同源', () => {
    const endpoints = resolveEndpoints(undefined, { WORKBUDDY_BASE_URL: 'https://copilot.tencent.com' })
    expect(new URL(endpoints.authStateUrl).host).toBe('copilot.tencent.com')
    expect(new URL(endpoints.chatUrl).host).toBe('copilot.tencent.com')
    expect(new URL(endpoints.configUrl).host).toBe('copilot.tencent.com')
    expect(endpoints.configUrl).toBe('https://copilot.tencent.com/v3/config')
  })

  it('签到与领积分的地址跟着同一个基址换', () => {
    const endpoints = resolveEndpoints(undefined, { WORKBUDDY_BASE_URL: 'https://copilot.tencent.com' })
    expect(endpoints.checkinStatusUrl).toBe('https://copilot.tencent.com/v2/billing/meter/checkin-activity-status')
    expect(endpoints.dailyCheckinUrl).toBe('https://copilot.tencent.com/v2/billing/meter/daily-checkin')
    expect(endpoints.creditsUrl).toBe('https://copilot.tencent.com/billing/meter/get-user-resource-summary')
  })

  it('显式指定的基址优先于环境变量，尾斜杠不产生双斜杠', () => {
    const endpoints = resolveEndpoints('https://x.example/', { WORKBUDDY_BASE_URL: 'https://env.example' })
    expect(endpoints.base).toBe('https://x.example')
    expect(endpoints.chatUrl).toBe('https://x.example/v2/chat/completions')
    expect(endpoints.authStateUrl).toBe('https://x.example/v2/plugin/auth/state')
  })
})

describe('请求体投影', () => {
  it('系统消息提到最前，用户消息合并，工具调用与工具结果各归其位', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '系统提示' }] },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'user', content: [{ type: 'text', text: '再来' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好' },
            { type: 'reasoning', text: '想了一下' },
            { type: 'tool-call', id: 'call-1', name: 'Bash', arguments: '{"cmd":"ls"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '文件列表' }] },
      ],
    })

    expect(body.model).toBe('auto')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '你好\n再来' },
      {
        role: 'assistant',
        content: '好',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '文件列表' },
    ])
  })

  it('推理块不重放：OpenAI 侧不需要推理签名，重放反而可能被拒', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [{
        role: 'assistant',
        content: [{ type: 'reasoning', text: '这段不该出现在请求里' }],
      }],
    })
    expect(JSON.stringify(body.messages)).not.toContain('这段不该出现在请求里')
  })

  it('工具调用缺 id 时用序号顶上，参数是原始 JSON 字符串', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool-call', name: 'Read', arguments: '{"path":"a.txt"}' }],
      }],
    })
    const assistant = body.messages[0]
    expect(assistant?.tool_calls?.[0]?.id).toBe('call-0')
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.txt"}')
  })

  it('模型支持视觉时图片进内容数组，不进文本', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      }],
      supportsImages: true,
    })
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ])
  })

  it('模型不支持视觉时图片退化成占位文本', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      }],
    })
    expect(body.messages[0]?.content).toBe('看图\n[image attached]')
  })

  it('工具投影成 function schema，缺参数补空对象，缺描述用工具名', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [],
      tools: [
        { name: 'Bash', description: '跑命令', parameters: { type: 'object', properties: {} } },
        { name: 'Read' },
      ],
    })
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'Bash', description: '跑命令', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'Read', description: 'Read', parameters: { type: 'object' } } },
    ])
  })

  it('调用方给的系统提示排在消息里的系统提示之前', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '消息里的' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
      system: '调用方给的',
    })
    expect(body.messages[0]?.content).toBe('调用方给的\n消息里的')
  })

  it('输出上限给了就用（取整），没给就不带这个字段', () => {
    expect(buildChatBody({ model: 'auto', messages: [], maxTokens: 1234.7 }).max_tokens).toBe(1234)
    expect(buildChatBody({ model: 'auto', messages: [] }).max_tokens).toBeUndefined()
  })
})

describe('推理档位', () => {
  it('档位在支持列表里才下发', () => {
    expect(resolveReasoningEffort('high', ['low', 'medium', 'high'])).toBe('high')
    expect(resolveReasoningEffort('ultra', ['low', 'high'])).toBeUndefined()
  })

  it('没有支持列表时按原样下发，none 关掉思考', () => {
    expect(resolveReasoningEffort('high', undefined)).toBe('high')
    expect(resolveReasoningEffort('none', undefined)).toBeUndefined()
    expect(resolveReasoningEffort(undefined, ['low'])).toBeUndefined()
  })
})

describe('网关指纹改写（请求体这一层）', () => {
  const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
  const FILE_REFERENCE = 'Tokens prefixed with @ are paths the user explicitly referenced.'

  it('系统提示里的指纹在进请求体前就改掉了', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: `${IDENTITY}\n${FILE_REFERENCE}`,
    })
    expect(body.messages[0]?.content).toBe(
      'You are an AI agent powered by DeepSeek-Harness.\nTokens prefixed with (at) are paths the user explicitly referenced.',
    )
  })

  it('历史里的助手消息也改（网关对助手消息一样查）', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: IDENTITY }] }],
    })
    expect(body.messages[0]?.content).toBe('You are an AI agent powered by DeepSeek-Harness.')
  })

  it('用户与工具消息一个字不动', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `前缀 @ 的路径是 ${IDENTITY}` }] },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Tokens prefixed with @ are paths' }] },
      ],
    })
    expect(body.messages[0]?.content).toContain(IDENTITY)
    expect(body.messages[1]?.content).toBe('Tokens prefixed with @ are paths')
  })

  it('兜底力度下系统提示里剩下的 @ 也换掉', () => {
    const body = buildChatBody({
      model: 'auto',
      messages: [],
      system: '另有一段带 @ 的说明文字。',
      gatewayTextMode: 'aggressive',
    })
    expect(body.messages[0]?.content).toBe('另有一段带 (at) 的说明文字。')
  })
})
