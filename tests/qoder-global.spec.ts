import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, stat, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startLogin, pollForToken, credentialOf, MODEL_URL, OPEN_API } from '../src/qoder/auth.ts'
import { readCredential, writeCredential, resolveCredential } from '../src/qoder/credential.ts'
import { buildQoderBody, streamQoder, readQoderEvents } from '../src/qoder/chat.ts'
import { modelPluginStream, isModelBackedAgent } from '../src/model-plugins.ts'
import { registerQoderRoutes, LOGIN_PATH, SESSION_PATH } from '../src/qoder-route.ts'
import type { WorkBuddyRouteContext } from '../src/workbuddy-route.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const credential = { accessToken: 'secret-access', refreshToken: 'secret-refresh', machineId: 'machine', expiresAt: Date.now() + 3600_000 }
const request = { provider: 'acp:acp-qoder-global', model: 'auto', messages: [{ role: 'user', content: 'hello' }] }
const collect = async <T>(stream: AsyncIterable<T>) => { const result: T[] = []; for await (const v of stream) result.push(v); return result }
function sse(events: unknown[]) {
  return new Response(events.map(v => `data: ${JSON.stringify(v)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

describe('Qoder global auth', () => {
  it('generates PKCE without placing the verifier in the browser URL', () => {
    const a = startLogin(), b = startLogin(), url = new URL(a.url)
    expect(url.origin).toBe('https://qoder.com')
    expect(url.searchParams.get('challenge')).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
    expect(a.url).not.toContain(a.verifier)
    expect(a.nonce).not.toBe(b.nonce)
  })
  it('waits for HTTP 404, then parses the top-level token (not axios data.data)', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ token: 'value', expires_in: 3600, user_id: 'uid', user_name: 'name' }))
    const result = await pollForToken(startLogin(), { fetchImpl: mock, intervalMs: 0 })
    expect(result.accessToken).toBe('value')
    expect(result.account).toEqual({ uid: 'uid', nickname: 'name' })
    expect(mock.mock.calls[0]?.[0]).toContain(`${OPEN_API}/api/v1/deviceToken/poll?`)
    expect(() => credentialOf({ data: { token: 'wrong' } }, 'm')).toThrow()
  })
  it('cancels pending authentication and fails terminal HTTP statuses without reflecting secrets', async () => {
    const abort = new AbortController(); abort.abort()
    const mock = vi.fn()
    await expect(pollForToken(startLogin(), { fetchImpl: mock, signal: abort.signal })).rejects.toThrow()
    expect(mock).not.toHaveBeenCalled()
    await expect(pollForToken(startLogin(), { fetchImpl: vi.fn().mockResolvedValue(new Response('secret', { status: 403 })) })).rejects.toThrow('HTTP 403')
  })
  it('tightens an existing directory and rotates concurrent requests only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qoder-test-')), file = join(root, 'auth', 'credentials.json')
    try {
      await mkdir(join(root, 'auth'), { mode: 0o755 })
      await writeCredential({ ...credential, expiresAt: 1 }, file)
      expect((await stat(join(root, 'auth'))).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      const mock = vi.fn().mockImplementation(async () => Response.json({ device_token: 'rotated', refresh_token: 'rotated-refresh', expires_at: new Date(Date.now() + 3600_000).toISOString() }))
      const results = await Promise.all([resolveCredential({ file, fetchImpl: mock }), resolveCredential({ file, fetchImpl: mock })])
      expect(mock).toHaveBeenCalledTimes(1)
      expect(results.map(c => c.accessToken)).toEqual(['rotated', 'rotated'])
      expect((await readCredential(file))?.refreshToken).toBe('rotated-refresh')
      await resolveCredential({ file, fetchImpl: mock, rejectedToken: 'secret-access' })
      expect(mock).toHaveBeenCalledTimes(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
describe('Qoder model protocol', () => {
  it('adds request identity and preserves explicit none reasoning', () => {
    const body = buildQoderBody({ ...request, reasoningEffort: 'none', system: 'system', maxTokens: 128 }, 'r', 's')
    expect(body.metadata.context).toEqual({ request_id: 'r', request_set_id: 'r', session_id: 's', client_type: '5' })
    expect(body.reasoning_effort).toBe('none')
    expect(body.stream_options.include_usage).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system' })
  })
  it('retries 401 once and folds split tool arguments and usage', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(sse([
      { choices: [{ delta: { reasoning_content: 'thinking', tool_calls: [{ index: 0, id: 't', function: { name: 'read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ]))
    const resolve = vi.fn().mockResolvedValue(credential)
    const chunks = await collect(streamQoder(request, { fetchImpl: mock, credential: resolve }))
    expect(resolve.mock.calls[1]).toEqual(['secret-access'])
    expect(mock.mock.calls[0]?.[0]).toBe(MODEL_URL)
    expect(mock.mock.calls[0]?.[1].redirect).toBe('error')
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'tool-call', id: 't', name: 'read', arguments: '{"path":"x"}' } }))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } })
  })
  it.each([
    [{ choices: [{ delta: { content: 'partial' } }] }],
    [{ error: { message: 'secret-access' } }],
    [],
  ])('rejects incomplete or error SSE rather than reporting success: %j', async (...events) => {
    await expect(collect(streamQoder(request, { fetchImpl: vi.fn().mockResolvedValue(sse(events)), credential: async () => credential }))).rejects.toThrow('Qoder')
  })
  it('rejects explicit SSE errors and malformed frames even after a finish', async () => {
    for (const raw of ['event: error\ndata: {"message":"private-token"}\n\n', 'data: {broken}\n\n']) {
      await expect(collect(readQoderEvents(new Response(raw).body!))).rejects.toThrow('Qoder')
    }
  })
  it('handles CRLF and UTF-8 split at arbitrary byte boundaries', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"你好"}\r\n\r\n')
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close() } })
    expect(await collect(readQoderEvents(stream))).toEqual([{ text: '你好' }])
  })
  it('does not retry a second 401 or reflect upstream response bodies', async () => {
    const mock = vi.fn().mockImplementation(async () => new Response('secret-access', { status: 401 }))
    await expect(collect(streamQoder(request, { fetchImpl: mock, credential: async () => credential }))).rejects.toThrow('HTTP 401')
    expect(mock).toHaveBeenCalledTimes(2)
  })
  it('does not send an already cancelled turn', async () => {
    const controller = new AbortController(); controller.abort()
    const mock = vi.fn()
    await expect(collect(streamQoder({ ...request, signal: controller.signal }, { fetchImpl: mock, credential: async () => credential }))).rejects.toThrow()
    expect(mock).not.toHaveBeenCalled()
  })
  it('claims only the global model row, leaving the CN ACP dialect intact', () => {
    expect(isModelBackedAgent('qoder-global')).toBe(true)
    expect(isModelBackedAgent('qoder')).toBe(false)
    const stream = modelPluginStream({ presets: { global: { agent: 'qoder-global' }, cn: { agent: 'qoder' } } })
    expect(stream('global', request)).toBeDefined()
    expect(stream('cn', request)).toBeUndefined()
  })
})
describe('Qoder login host integration', () => {
  it('deduplicates login, protects routes, hides secrets, and cancels on disposal', async () => {
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
    let dispose: (() => void) | undefined
    const ctx: WorkBuddyRouteContext = {
      effect: fn => { dispose = fn() as () => void },
      connection: { admit: req => req.headers.cookie ? { peer: {} } : { rejection: 401 } },
      webServer: { register: route => { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } },
    }
    const box: { signal?: AbortSignal } = {}
    const poll = vi.fn((_login, options) => { box.signal = options.signal; return new Promise<never>(() => {}) })
    registerQoderRoutes(ctx, { startLogin, pollForToken: poll, readCredential: async () => credential, writeCredential: vi.fn() })
    async function call(path: string, method: string, authorized = true) {
      const result = { status: 0, body: '' }
      await routes.get(path)?.({ method, headers: { cookie: authorized ? 'yes' : '' } } as IncomingMessage,
        { writeHead: (status: number) => { result.status = status }, end: (body: string) => { result.body = body } } as unknown as ServerResponse)
      return result
    }
    expect((await call(LOGIN_PATH, 'POST', false)).status).toBe(401)
    expect((await call(LOGIN_PATH, 'GET')).status).toBe(405)
    const first = await call(LOGIN_PATH, 'POST'), second = await call(LOGIN_PATH, 'POST')
    expect(first.body).toBe(second.body); expect(poll).toHaveBeenCalledTimes(1)
    expect((await call(SESSION_PATH, 'GET')).body).not.toContain('secret')
    dispose?.(); expect(box.signal?.aborted).toBe(true); expect(routes.size).toBe(0)
  })
  it('ships both model and route in the preset and health manifest', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: acp-qoder-global')
    expect(patch).toContain('@goodjin2/dsh-acp-agent/qoder-login')
  })
})
