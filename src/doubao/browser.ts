/**
 * Driving the Doubao desktop app as our model runtime.
 *
 * The app is a Chromium shell (not Electron, no `app.asar`), and the only
 * way in is its own debugging port: starting it with
 * `--remote-debugging-port=<port>` makes the shell forward the switch to its
 * embedded Chromium (measured 2026-11-05), and the chat page then shows up as
 * the CDP target `chrome://doubao-chat/chat`.
 *
 * The shell has to be restarted for that: an app that is already running
 * hands a second launch over to the running instance, which has no port, so
 * the port never opens. This module therefore starts the app itself and says
 * plainly when the user has to quit the running one first.
 *
 * Everything the agent needs from the page goes through two trusted-input
 * steps and one read:
 *   - click the editor (a real mouse event, so the app focuses it),
 *   - `Input.insertText` (a real text insertion; assigning `.value` in the
 *     page does not reach the app's own state — measured, the field came back
 *     empty),
 *   - click the send control.
 */

import { spawn, execFileSync } from 'node:child_process'
import { attachPage, connectCdp, evaluate, type CdpConnection, type CdpSession } from './cdp.ts'
import { SNAPSHOT_SCRIPT, type DomSnapshot } from './dom.ts'

export type DoubaoBrowserOptions = {
  /** DevTools port to use. */
  port?: number
  /** Path of the Doubao executable to start when no port is open. */
  appPath?: string
  /** How long to wait for the app and its chat page to come up. */
  startupTimeoutMs?: number
  /** Where to report what the driver is doing (stderr of the agent). */
  onDiagnostic?: (line: string) => void
}

const DEFAULT_PORT = 9555
const DEFAULT_APP_PATH = '/Applications/Doubao.app/Contents/MacOS/Doubao'

/** Where the editor is, in viewport coordinates, so a real click can focus it. */
const EDITOR_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 20 && r.height > 5 && r.bottom > 0 && r.top < window.innerHeight
  }
  const textarea = document.querySelector('textarea')
  const editable = document.querySelector('[contenteditable=true]')
  const el = visible(textarea) ? textarea : (visible(editable) ? editable : (textarea || editable))
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

/** Where the send control is. The web build has an id; the desktop build does not. */
const SEND_SCRIPT = `(() => {
  const center = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  const byId = document.getElementById('flow-end-msg-send')
  if (byId) {
    const r = byId.getBoundingClientRect()
    if (r.width > 0) return center(byId)
  }
  const candidates = []
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.bottom > window.innerHeight - 220) candidates.push({ el, left: r.left })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.left - a.left)
  return center(candidates[0].el)
})()`

/** Where the stop control is, while the model is still generating. */
const STOP_SCRIPT = `(() => {
  for (const el of document.querySelectorAll('button,[role=button],[aria-label]')) {
    const label = ((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + (el.innerText || '')
    if (/停止生成|stop generating/i.test(label)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
  }
  return null
})()`

type Point = { x: number; y: number }

export class DoubaoBrowser {
  private readonly connection: CdpConnection
  private readonly session: CdpSession
  private readonly options: DoubaoBrowserOptions

  // No constructor parameter properties: DSH strips the types of plugin
  // sources with a strip-only eraser, and `constructor(private readonly x: T)`
  // is syntax it cannot erase (see tests/strip-only-syntax.spec.ts).
  private constructor(connection: CdpConnection, session: CdpSession, options: DoubaoBrowserOptions) {
    this.connection = connection
    this.session = session
    this.options = options
  }

  /**
   * Open the app (if needed) and attach to its chat page.
   *
   * Throws when the port cannot be opened — with the reason, because the
   * commonest cause is an app that is already running without the port, and
   * that one only the user can fix.
   */
  static async open(options: DoubaoBrowserOptions = {}): Promise<DoubaoBrowser> {
    const port = options.port ?? DEFAULT_PORT
    const appPath = options.appPath ?? DEFAULT_APP_PATH
    const timeoutMs = options.startupTimeoutMs ?? 30_000
    const report = options.onDiagnostic ?? (() => {})

    let connection = await DoubaoBrowser.tryConnect(port)
    if (!connection) {
      if (DoubaoBrowser.isAppRunning()) {
        throw new Error(
          '豆包桌面端已经在运行，但它不是带调试端口启动的——再启动一个会把请求转给它自己，端口不会开。'
          + '请先退出豆包再重试。之后由我们启动的豆包会带着调试端口，那个窗口你照常用即可。',
        )
      }
      report(`doubao: no devtools on port ${port}, starting the app`)
      DoubaoBrowser.startApp(appPath, port)
      connection = await DoubaoBrowser.waitForConnection(port, timeoutMs, report)
    }
    const session = await DoubaoBrowser.waitForChatPage(connection, timeoutMs, report)
    return new DoubaoBrowser(connection, session, options)
  }

  private static async tryConnect(port: number): Promise<CdpConnection | undefined> {
    try {
      return await connectCdp(port, { timeoutMs: 3000 })
    } catch {
      return undefined
    }
  }

  /**
   * Whether a 豆包 is already running.
   *
   * A running instance answers a second launch by handing the request over to
   * itself, so a new one never gets the debugging port (measured 2026-11-05:
   * the second launch produced no listener at all). That makes "豆包 already
   * running" a case the user has to resolve — we say so instead of waiting
   * for a port that will never open.
   */
  private static isAppRunning(): boolean {
    try {
      const output = execFileSync('/usr/bin/pgrep', ['-f', 'Doubao Browser'], { encoding: 'utf8' })
      return output.trim().length > 0
    } catch {
      // pgrep exits non-zero when nothing matches.
      return false
    }
  }

  private static startApp(appPath: string, port: number): void {
    const child = spawn(appPath, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' })
    child.unref()
  }

  private static async waitForConnection(
    port: number,
    timeoutMs: number,
    report: (line: string) => void,
  ): Promise<CdpConnection> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const connection = await DoubaoBrowser.tryConnect(port)
      if (connection) {
        report(`doubao: devtools ready on port ${port}`)
        return connection
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(
      `豆包桌面端没有在 ${String(timeoutMs)}ms 内开放调试端口 ${String(port)}。`
      + '如果豆包已经在运行，请先退出它再重试——已在运行的实例不会接受新的调试端口。',
    )
  }

  private static async waitForChatPage(
    connection: CdpConnection,
    timeoutMs: number,
    report: (line: string) => void,
  ): Promise<CdpSession> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const session = await attachPage(connection, url => url.includes('doubao-chat/chat'))
      if (session) {
        report('doubao: attached to the chat page')
        return session
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('豆包的聊天页面没有出现（找不到 doubao-chat 目标）')
  }

  /** Read the current state of the conversation. */
  async snapshot(): Promise<DomSnapshot> {
    return await evaluate<DomSnapshot>(this.connection, this.session.sessionId, SNAPSHOT_SCRIPT)
  }

  /**
   * Type a prompt and send it.
   *
   * The text goes in through a real insertion, so the app's own state knows
   * about it; a programmatically assigned value does not survive.
   */
  async sendPrompt(text: string): Promise<void> {
    const editor = await evaluate<Point | null>(this.connection, this.session.sessionId, EDITOR_SCRIPT)
    if (!editor) throw new Error('豆包页面上找不到输入框（输入区可能还在加载）')
    await this.click(editor)
    await this.connection.send('Input.insertText', { text }, this.session.sessionId)
    await new Promise(resolve => setTimeout(resolve, 300))
    const send = await evaluate<Point | null>(this.connection, this.session.sessionId, SEND_SCRIPT)
    if (!send) throw new Error('豆包页面上找不到发送按钮')
    await this.click(send)
  }

  /** Click the stop control, if the model is still generating. */
  async stopGeneration(): Promise<void> {
    const stop = await evaluate<Point | null>(this.connection, this.session.sessionId, STOP_SCRIPT)
    if (!stop) return
    await this.click(stop)
  }

  private async click(point: Point): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.connection.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      }, this.session.sessionId)
    }
  }

  /** Release the DevTools connection. */
  async close(): Promise<void> {
    this.connection.close()
  }

  /** The options this browser was opened with. */
  get settings(): DoubaoBrowserOptions {
    return this.options
  }
}
