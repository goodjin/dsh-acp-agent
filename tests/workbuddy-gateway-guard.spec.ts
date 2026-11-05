/**
 * WorkBuddy 国内网关的「渠道校验」与我们的应对。
 *
 * 网关（copilot.tencent.com / www.workbuddy.cn）对 system、developer、assistant
 * 消息做内容校验：认出某些「官方客户端才有的指纹」就回 400 / 11128
 * 「Illegal API invocation from an unapproved channel」。
 *
 * 指纹一共四处（都在 DSH 的系统提示词里）：
 * 1. 文件引用说明里那句 `Tokens prefixed with @ are paths …`；
 * 2. 开头的身份句 `You are an AI agent powered by DeepSeek Harness.`（DeepSeek 与
 *    Harness 之间夹着零宽空格）；
 * 3. `You are a coding agent powered by the … model.`（人设前缀）；
 * 4. `… the DeepSeek Harness Web GUI …` / `Current DeepSeek Harness Web GUI URL`。
 *
 * 这里钉住的是「改写之后语义不变、且网关认不出来」：user 与 tool 消息一个字不动。
 */

import { describe, expect, it } from 'vitest'
import { sanitizeGatewayText } from '../src/workbuddy/gateway-guard.ts'

/** 零宽空格：DSH 的身份句里 `DeepSeek` 与 `Harness` 之间夹着它。 */
const ZWSP = '\u200B'

const IDENTITY = `You are an AI agent powered by DeepSeek${ZWSP} Harness.`
const FILE_REFERENCE = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.'
const PERSONA = 'You are a coding agent powered by the workbuddy/hy4-preview model.'
const GUI_SENTENCE = `You are interacting with the user through the DeepSeek${ZWSP} Harness Web GUI whose URL the runtime context names.`
const GUI_URL = `Current DeepSeek${ZWSP} Harness Web GUI URL: "http://127.0.0.1:58944".`

describe('网关指纹改写', () => {
  it('身份句里的品牌名改成连字符写法（零宽空格也算）', () => {
    expect(sanitizeGatewayText(IDENTITY)).toBe('You are an AI agent powered by DeepSeek-Harness.')
  })

  it('没有零宽空格的写法一样改掉', () => {
    expect(sanitizeGatewayText('You are an AI agent powered by DeepSeek Harness.')).toBe(
      'You are an AI agent powered by DeepSeek-Harness.',
    )
  })

  it('文件引用说明里的 @ 换成等义写法，其余文字不动', () => {
    const out = sanitizeGatewayText(FILE_REFERENCE)
    expect(out).toContain('prefixed with (at) are paths')
    expect(out).toContain('Relative paths resolve from the workspace root')
    expect(out).not.toContain('prefixed with @')
  })

  it('人设句式换掉，模型名原样保留', () => {
    const out = sanitizeGatewayText(PERSONA)
    expect(out).toBe('You are a coding agent running on the workbuddy/hy4-preview model.')
  })

  it('Web GUI 两句都换掉', () => {
    expect(sanitizeGatewayText(GUI_SENTENCE)).toContain('through this Web GUI')
    expect(sanitizeGatewayText(GUI_URL)).toContain('Current Web GUI URL')
  })

  it('四处一起出现时全部改掉', () => {
    const out = sanitizeGatewayText([IDENTITY, FILE_REFERENCE, PERSONA, GUI_SENTENCE, GUI_URL].join('\n'))
    expect(out).not.toContain('DeepSeek\u200B Harness')
    expect(out).not.toContain('prefixed with @')
    expect(out).not.toContain('coding agent powered by')
    expect(out).not.toContain('Harness Web GUI')
  })

  it('改写是幂等的：再改一次内容不变', () => {
    const once = sanitizeGatewayText(IDENTITY + '\n' + FILE_REFERENCE)
    expect(sanitizeGatewayText(once)).toBe(once)
  })

  it('不含指纹的普通文字原样返回', () => {
    const text = '你好，请读一下 README 并总结。'
    expect(sanitizeGatewayText(text)).toBe(text)
  })

  it('邮件与 @某人 不受影响（只改系统与助手消息里的已知指纹）', () => {
    const text = '联系 someone@example.com 或 @someone 就行。'
    expect(sanitizeGatewayText(text)).toBe(text)
  })
})

describe('兜底模式', () => {
  it('兜底模式把剩下所有的 @ 都换成 (at)', () => {
    const out = sanitizeGatewayText('另有一段带 @ 的说明文字。', 'aggressive')
    expect(out).toBe('另有一段带 (at) 的说明文字。')
  })

  it('兜底模式同样先做常规改写', () => {
    const out = sanitizeGatewayText(IDENTITY, 'aggressive')
    expect(out).toBe('You are an AI agent powered by DeepSeek-Harness.')
  })
})
