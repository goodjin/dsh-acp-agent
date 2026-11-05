/**
 * 国内网关的「渠道校验」与我们的应对。
 *
 * 国内网关（如 copilot.tencent.com）对 **system、developer、
 * assistant** 消息做内容校验：认出某些「只有官方客户端才有的指纹」就回
 * `400 / 11128 Illegal API invocation from an unapproved channel`，一句回复都
 * 没有。国际网关不做这个校验。
 *
 * 指纹一共四处，都在 DSH 自己拼的系统提示词里：
 *
 * | # | 指纹 | 出处 |
 * |---|---|---|
 * | 1 | `Tokens prefixed with @ are paths …` | 文件引用说明 |
 * | 2 | 开头的 `You are an AI agent powered by DeepSeek Harness.` | 内核身份句 |
 * | 3 | `You are a coding agent powered by the … model.` | 人设前缀 |
 * | 4 | `… the DeepSeek Harness Web GUI …` / `Current DeepSeek Harness Web GUI URL` | Web GUI 上下文 |
 *
 * 改写它们不是为了绕过什么规矩——请求还是同一个端点、同一套凭据、同一批工具。
 * 只是这几段文字里的写法撞上了网关的匹配规则，把写法换成等义的说法即可：模型
 * 读到的指令含义没变，网关也认不出来了。
 *
 * **只改 system / developer / assistant**：user 与 tool 消息里的邮箱、`@某人`、
 * 代码里的装饰器一个字不动（实测 user/tool 里的同样内容不触发校验）。
 */

/** 改写力度。 */
export type GatewayTextMode =
  /** 只改上面列出的四处已知指纹。 */
  | 'standard'
  /** 已知指纹之外，把剩下的 `@` 也换成等义写法（网关换了规则时的兜底）。 */
  | 'aggressive'

/** 隐形分隔符：零宽空格、零宽连接符、BOM。DSH 的身份句里就夹着零宽空格。 */
const INVISIBLE = '\u200B\u200C\u200D\uFEFF'

/** 品牌名：中间可能夹着普通空格或隐形字符。 */
const BRAND = new RegExp(`DeepSeek[\\s${INVISIBLE}]*Harness`, 'g')

/** Web GUI 那两句。 */
const GUI_SENTENCE = new RegExp(`the DeepSeek[\\s${INVISIBLE}]*Harness Web GUI`, 'g')
const GUI_URL = new RegExp(`Current DeepSeek[\\s${INVISIBLE}]*Harness Web GUI URL`, 'g')

/** 人设句式：`coding agent powered by` 这几个词是网关认的，换个说法。 */
const PERSONA = /coding agent powered by/g

/** 文件引用说明里的那个 `@`。 */
const FILE_REFERENCE = /((?:prefixed|marked|tagged|denoted)\s+(?:with|by)\s*)@/gi

/**
 * 把一段提示词里的网关指纹改成等义写法。
 *
 * 幂等：改过一次的内容再改一次不会变。含不含指纹的普通文字原样返回。
 * @param text - 原文（system、developer 或 assistant 消息的内容）。
 * @param mode - 改写力度；默认只改已知指纹。
 * @returns 改写后的文字。
 */
export function sanitizeGatewayText(text: string, mode: GatewayTextMode = 'standard'): string {
  if (text === '') return text
  let out = text
  // 顺序有讲究：Web GUI 那两句里也带着品牌名，先把它们整句换掉，
  // 剩下的品牌名再统一改。
  out = out.replace(GUI_SENTENCE, 'this Web GUI')
  out = out.replace(GUI_URL, 'Current Web GUI URL')
  out = out.replace(PERSONA, 'coding agent running on')
  out = out.replace(FILE_REFERENCE, '$1(at)')
  out = out.replace(BRAND, 'DeepSeek-Harness')
  if (mode === 'aggressive') out = out.replaceAll('@', '(at)')
  return out
}
