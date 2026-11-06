/**
 * 每日签到的飞书通知。
 *
 * 插件在宿主进程里没有别的通知通道，而 `lark-cli` 是本机既有的工具（ZCode 的
 * 每日领取也走它）。这里用子进程调它，以 bot 身份把结果发给一个人。
 *
 * 通知失败只记日志、不重试、不抛：无人值守的时候，不能因为一条通知发不出去
 * 就把签到判成失败——签到本身已经成功了。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 收件人（金山 / AI 中台），与 ZCode 每日领取那套一致。 */
export const FEISHU_USER_ID = 'ou_988714d586bf828e5a9642403924a690'

/** 通知超时：一条通知不该把签到流程挂住。 */
const DEFAULT_TIMEOUT_MS = 20_000

/** 一次子进程调用的结果。 */
export type CommandResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 通知要什么。 */
export type MiniMaxNotifyOptions = {
  /** 收件人；缺省用 {@link FEISHU_USER_ID}。 */
  readonly userId?: string
  /** lark-cli 的位置；缺省从 PATH 里找。 */
  readonly cliPath?: string
  /** 子进程超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 换掉子进程（测试立桩）。 */
  readonly run?: ((command: string, args: string[]) => Promise<CommandResult>) | undefined
  /** 环境变量；通知开关与收件人都从这里读。 */
  readonly env?: NodeJS.ProcessEnv
}

/** 通知的结果。 */
export type NotifyResult = {
  /** 发出去了没有。 */
  readonly ok: boolean
  /** 失败原因（成功时没有）。 */
  readonly detail?: string
  /** 没发是因为被开关关掉了。 */
  readonly skipped?: boolean
}

/**
 * 发一条飞书消息。
 *
 * 关掉的办法：环境变量 `MINIMAX_CHECKIN_FEISHU=0`。
 * 换收件人：`MINIMAX_CHECKIN_FEISHU_USER_ID=ou_…`。
 * @param message - 一句话 Markdown。
 * @param options - 收件人、命令位置与超时。
 * @returns 发没发出去；失败时带一句原因。
 */
export async function sendFeishuNotification(
  message: string,
  options: MiniMaxNotifyOptions = {},
): Promise<NotifyResult> {
  const env = options.env ?? process.env
  if (env['MINIMAX_CHECKIN_FEISHU'] === '0') return { ok: false, skipped: true, detail: '通知被 MINIMAX_CHECKIN_FEISHU=0 关掉了' }
  const userId = options.userId ?? env['MINIMAX_CHECKIN_FEISHU_USER_ID'] ?? FEISHU_USER_ID
  const cli = options.cliPath ?? resolveCliPath(env)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const run = options.run ?? ((command: string, args: string[]) => runCommand(command, args, timeoutMs))
  const args = [
    'im', '+messages-send',
    '--user-id', userId,
    '--markdown', message,
    '--as', 'bot',
  ]
  try {
    const result = await run(cli, args)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().slice(0, 300)
      return { ok: false, detail: detail === '' ? `lark-cli 退出码 ${String(result.code)}` : detail }
    }
    const parsed = parseJson(result.stdout)
    // lark-cli 的成功判据是 `ok === true`，不是退出码。
    if (parsed !== undefined && parsed.ok !== true) {
      const detail = typeof parsed['error'] === 'string' ? parsed['error'] : (result.stdout || '').trim().slice(0, 300)
      return { ok: false, detail: detail === '' ? 'lark-cli 没有回 ok=true' : detail }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 领到积分时的一句话。 */
export function formatClaimedMessage(points: number, dayNo: number, streakDays: number, expiresAtMs: number): string {
  const expiry = new Date(expiresAtMs).toLocaleDateString('zh-CN')
  return `MiniMax 每日签到：领到 ${String(points)} 积分（第 ${String(dayNo)} 天，连续 ${String(streakDays)} 天），积分 ${expiry} 过期。`
}

/** 已经领过时的一句话。 */
export function formatAlreadyClaimedMessage(): string {
  return 'MiniMax 每日签到：今天已经领过了。'
}

/** 失败时的一句话。 */
export function formatFailureMessage(reason: string): string {
  return `MiniMax 每日签到没成功：${reason}`
}

/**
 * lark-cli 在哪。
 *
 * 图形界面启动的宿主进程拿不到 shell 里的 PATH（`~/bin` 是 `.zshrc` 加的），
 * 所以先看环境变量、再看 `~/bin/lark-cli`，最后才退回 PATH 里的名字。
 * @param env - 环境变量。
 * @returns lark-cli 的位置。
 */
export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LARK_CLI']
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  const inHome = join(homedir(), 'bin', 'lark-cli')
  if (existsSync(inHome)) return inHome
  return 'lark-cli'
}

/**
 * 子进程要用的 PATH。
 *
 * 图形界面启动的宿主进程只有最小 PATH，而 `lark-cli` 的 shebang 是
 * `#!/usr/bin/env node`——找不到 node 就跑不起来。这里把宿主自己的可执行文件
 * 所在目录、`~/bin` 与几个常见的 node 位置补进去。
 * @param env - 当前环境。
 * @returns 给子进程的 PATH。
 */
export function childPath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    dirname(process.execPath),
    join(homedir(), 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const existing = env['PATH'] ?? ''
  return [...new Set([...candidates, existing])].filter(part => part !== '').join(':')
}

/** 真的子进程调用。 */
async function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return await new Promise(resolve => {
    execFile(command, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, PATH: childPath(process.env) },
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** 解析 JSON；不是 JSON 就当没有。 */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
