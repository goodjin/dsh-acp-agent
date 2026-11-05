# Qoder 国际版模型行 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `dsh-acp-agent` 里加一行「Qoder 国际版」模型行：插件自己用设备码登录，直连 Qoder 国际版的模型接口，工具仍由 DSH 执行。

**Architecture:** 复用仓库里已有的 WorkBuddy 模型插件形态（凭据文件 → 运行时清单 → 模型流）。
新增 `src/qoder/` 四个模块（端点、登录、凭据、清单）+ `src/qoder/chat.ts`（模型请求），
由 `src/qoder-model.ts` 认下 `agent: qoder-global` 的预置行，宿主侧挂两条登录路由，
浏览器侧加一节账号状态。CN 版 `acp-qoder` 行不碰。

**Tech Stack:** TypeScript（`tsc --noEmit`）、vitest、`node:fetch` 原生 fetch、`proper-lockfile`（仓库已有）。

**Spec:** `docs/superpowers/specs/2026-11-05-qoder-global-agent-design.md`

## Global Constraints

- 端点默认是国际版 prod 一组常量：`https://qoder.com`、`https://openapi.qoder.sh`、
  `https://api3.qoder.sh`、`https://api2-v2.qoder.sh`。每个各有一个环境变量可覆盖：
  `QODER_LOGIN_BASE` / `QODER_OPENAPI_BASE` / `QODER_CATALOG_BASE` / `QODER_MODEL_BASE`。
- 设备码轮询的 **HTTP 404 表示「还没授权」**，是等待态，不是错误；其它非 2xx 才是失败。
- 轮询应答是**顶层** `{token, refresh_token, expires_at | expires_in, user_id, user_name}`，没有 `data` 外壳。
- 续期应答是 `{device_token, refresh_token, expires_at, refresh_token_expires_at}`。
- 轮询拿到的 `token` 直接作模型请求的 Bearer，不换票。
- 模型清单按**场景分组**：`GET {catalog}/api/v2/model/list?Encode=1` → `{"assistant": [ … ]}`，
  取 `assistant` 组；模型 id 是条目的 `key`。
- 模型请求：`POST {model}/model/v1/chat/completions`，SSE，头含 `Authorization`、`Accept: text/event-stream`、
  `X-Request-ID`、`X-Session-ID`、`Cosy-Version`、`Cosy-ClientType: 5`、`Cosy-MachineOS`；
  体含 `metadata.context`（`request_id`/`request_set_id`/`session_id`/`client_type`）。
- 凭据存 `~/.dsh/qoder-global/credentials.json`：文件 0600、目录 0700，**目录已存在时也要收紧**。
- **不读、不写 Qoder 桌面版自己的凭据**（它在加密存储里）。
- 错误信息里**不许反射令牌**；SSE 断流不能当成一次成功的空回答。
- 面向用户的文案用中文，注释用中文；模块顶层的注释写「核对时间 + 来源」。

## Review Focus

1. **令牌被打入日志或错误信息**：用户贴日志求助时不该顺手泄了账号。
2. **目录已存在时权限没收紧**：`mkdir` 的 mode 只在新建时生效——这是 WorkBuddy 真实踩过的坑。
3. **没登录时每一轮都去拉清单**：上游被打爆，且界面一直在转。
4. **SSE 断流被当成成功**：用户看到「模型什么都没说」，而不是一句错误。
5. **CN 版 `acp-qoder` 行被牵连**：两行并存，改一处不能坏另一处。

---

### Task 1: 端点与身份常量

**Files:**
- Create: `src/qoder/endpoints.ts`
- Test: `tests/qoder-endpoints.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type QoderEndpoints = { loginBase, openapiBase, catalogBase, modelBase, pollUrl, refreshUrl, modelListUrl, chatUrl, accountUrl }`（全部为只读字符串）
  - `resolveEndpoints(env?: NodeJS.ProcessEnv): QoderEndpoints`
  - `DEFAULT_QODER_ENDPOINTS: QoderEndpoints`
  - `qoderIdentityHeaders(version?: string): Record<string, string>`（`Cosy-Version` / `Cosy-ClientType` / `Cosy-MachineOS`）

- [ ] **Step 1: 写失败测试**

```ts
it('四个默认端点来自同一套国际版 prod 环境', () => {
  const e = resolveEndpoints({})
  expect(e.loginBase).toBe('https://qoder.com')
  expect(e.openapiBase).toBe('https://openapi.qoder.sh')
  expect(e.catalogBase).toBe('https://api3.qoder.sh')
  expect(e.modelBase).toBe('https://api2-v2.qoder.sh')
  expect(e.pollUrl).toBe('https://openapi.qoder.sh/api/v1/deviceToken/poll')
  expect(e.refreshUrl).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
  expect(e.modelListUrl).toBe('https://api3.qoder.sh/api/v2/model/list?Encode=1')
  expect(e.chatUrl).toBe('https://api2-v2.qoder.sh/model/v1/chat/completions')
})
it('环境变量可以逐个换掉端点', () => {
  const e = resolveEndpoints({ QODER_MODEL_BASE: 'https://model.example.com/' })
  expect(e.modelBase).toBe('https://model.example.com')
  expect(e.chatUrl).toBe('https://model.example.com/model/v1/chat/completions')
  expect(e.pollUrl).toContain('openapi.qoder.sh')
})
it('身份头带上客户端类型与机器', () => {
  expect(qoderIdentityHeaders('1.2.3')).toMatchObject({ 'Cosy-Version': '1.2.3', 'Cosy-ClientType': '5' })
  expect(qoderIdentityHeaders()['Cosy-MachineOS']).toMatch(/_(darwin|linux|win32)$/)
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/qoder-endpoints.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/qoder/endpoints.ts`**

四个环境变量各自覆盖一项；覆盖值去掉尾斜杠；未覆盖的用默认常量。`chatUrl` 由 `modelBase` 拼
`/model/v1/chat/completions`，`pollUrl`/`refreshUrl` 由 `openapiBase` 拼 `/api/v1/deviceToken/…`，
`modelListUrl` 由 `catalogBase` 拼 `/api/v2/model/list?Encode=1`，`accountUrl` 由 `centerBase` 拼
`/api/v1/userinfo`（`centerBase` 默认 `https://center.qoder.sh`，覆盖变量 `QODER_CENTER_BASE`）。
`qoderIdentityHeaders(version = '1.1.79-hotfix.11')` 返回 `Cosy-Version`/`Cosy-ClientType: '5'`/
`Cosy-MachineOS: \`${arch}_${platform}\``（arm64 → aarch64）。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/qoder-endpoints.spec.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/qoder/endpoints.ts tests/qoder-endpoints.spec.ts
git commit -m "feat(qoder): 国际版端点与身份头"
```

---

### Task 2: 设备码登录（授权地址、轮询、续期）

**Files:**
- Create: `src/qoder/auth.ts`（已有雏形，本任务校准字段并接入 Task 1 的端点）
- Test: `tests/qoder-auth.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveEndpoints`、`QoderEndpoints`
- Produces:
  - `type QoderCredential = { accessToken, refreshToken?, expiresAt?, machineId, account?: { uid, nickname? } }`
  - `type QoderLogin = { url, nonce, verifier, machineId }`
  - `startLogin(options?: { endpoints?, machineId? }): QoderLogin`
  - `pollForToken(login, options: { fetchImpl?, signal?, timeoutMs?, intervalMs? }): Promise<QoderCredential>`
  - `refreshCredential(old, options: { fetchImpl? }): Promise<QoderCredential>`
  - `credentialOfPoll(payload: unknown, machineId: string): QoderCredential`
  - `credentialOfRefresh(payload: unknown, machineId: string): QoderCredential`

- [ ] **Step 1: 写失败测试**

```ts
it('授权地址带上 PKCE 参数，verifier 不进浏览器', () => {
  const login = startLogin({ machineId: 'mid' })
  const url = new URL(login.url)
  expect(url.origin).toBe('https://qoder.com')
  expect(url.pathname).toBe('/device/selectAccounts')
  expect(url.searchParams.get('challenge_method')).toBe('S256')
  expect(url.searchParams.get('challenge')).toBe(createHash('sha256').update(login.verifier).digest('base64url'))
  expect(url.searchParams.get('machine_id')).toBe('mid')
  expect(url.searchParams.get('client_id')).toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
  expect(login.url).not.toContain(login.verifier)
})
it('轮询把 404 当成还没授权', async () => {
  const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ token: 'v', expires_in: 3600, user_id: 'uid', user_name: 'n' }))
  const c = await pollForToken(startLogin({ machineId: 'mid' }), { fetchImpl: mock, intervalMs: 0 })
  expect(c.accessToken).toBe('v')
  expect(c.account).toEqual({ uid: 'uid', nickname: 'n' })
})
it('轮询应答是顶层的 token，不是 data.data', () => {
  expect(() => credentialOfPoll({ data: { token: 'x' } }, 'mid')).toThrow()
})
it('续期取 device_token，机器标识一起送上', async () => {
  const mock = vi.fn().mockResolvedValue(Response.json({ device_token: 'new', refresh_token: 'r2', expires_at: new Date(Date.now() + 3600_000).toISOString() }))
  const c = await refreshCredential({ accessToken: 'old', refreshToken: 'r1', machineId: 'mid' }, { fetchImpl: mock })
  expect(c.accessToken).toBe('new')
  expect(mock.mock.calls[0]?.[1].body).toContain('"machine_id":"mid"')
})
it('失败信息里不出现令牌', async () => {
  await expect(refreshCredential({ accessToken: 'secret', refreshToken: 'r1', machineId: 'mid' },
    { fetchImpl: vi.fn().mockResolvedValue(new Response('secret', { status: 500)) })).rejects.toThrow(/HTTP 500/)
})
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/qoder-auth.spec.ts` → FAIL

- [ ] **Step 3: 实现 `src/qoder/auth.ts`**

`startLogin`：verifier 为 48 字节随机 base64url，challenge 为其 SHA-256 的 base64url，nonce 为 UUID，
machineId 缺省随机 UUID；URL 为 `{loginBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`。
`pollForToken`：GET `{openapiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`；
404 → 等 `intervalMs`（默认 1000）后重试；其它非 2xx → 抛错（消息只含状态码）；
2xx → `credentialOfPoll`（读顶层 `token`；`expires_at` 或 `expires_in` → `expiresAt`；
`refresh_token` → `refreshToken`；`user_id`/`user_name` → `account`）。
`refreshCredential`：POST `{openapiBase}/api/v1/deviceToken/refresh`，体 `{refresh_token, machine_id}`；
读 `device_token`/`refresh_token`/`expires_at`；旧的 refreshToken 在新值缺失时保留。

- [ ] **Step 4: 跑测试确认绿** — PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(qoder): 设备码登录与续期"`

---

### Task 3: 凭据存放与跨进程续期

**Files:**
- Create: `src/qoder/credential.ts`（已有雏形，本任务收紧目录权限并接 Task 2）
- Test: `tests/qoder-credential.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `QoderCredential`、`refreshCredential`
- Produces:
  - `credentialFilePath(): string`
  - `readCredential(file?): Promise<QoderCredential | undefined>`
  - `writeCredential(credential, file?): Promise<void>`
  - `resolveCredential(options: { file?, rejectedToken?, fetchImpl? }): Promise<QoderCredential>`

- [ ] **Step 1: 写失败测试**

```ts
it('已存在的目录也会被收紧到 0700', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qoder-cred-'))
  const dir = join(root, 'qoder-global')
  await mkdir(dir, { mode: 0o755 })
  await writeCredential({ accessToken: 'a', machineId: 'm' }, join(dir, 'credentials.json'))
  expect((await stat(dir)).mode & 0o777).toBe(0o700)
  expect((await stat(join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600)
})
it('两个进程同时要续期只续一次，后来者用新令牌', async () => {
  const mock = vi.fn().mockResolvedValue(Response.json({ device_token: 'rotated', refresh_token: 'r2' }))
  const [a, b] = await Promise.all([
    resolveCredential({ file, fetchImpl: mock }),
    resolveCredential({ file, fetchImpl: mock }),
  ])
  expect(mock).toHaveBeenCalledTimes(1)
  expect(a.accessToken).toBe('rotated')
  expect(b.accessToken).toBe('rotated')
})
it('没登录时说清楚要登录', async () => {
  await expect(resolveCredential({ file: join(root, 'none.json') })).rejects.toThrow('登录')
})
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/qoder-credential.spec.ts` → FAIL

- [ ] **Step 3: 实现 `src/qoder/credential.ts`**

目录 `~/.dsh/qoder-global`（`DSH_HOME` 可改）：先 `mkdir` 再 `chmod 0700`（**两者都要**）；
凭据文件原子写（临时文件 + rename），mode 0600；跨进程用 `proper-lockfile` 串行化，
锁内先读——若磁盘上的令牌已经换过（与请求方拒绝的旧令牌不同）就直接采用，不再续期。

- [ ] **Step 4: 跑测试确认绿** — PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(qoder): 凭据存放与跨进程续期"`

---

### Task 4: 模型清单

**Files:**
- Create: `src/qoder/models.ts`
- Test: `tests/qoder-models.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveEndpoints`；Task 2 的 `QoderCredential`
- Produces:
  - `type QoderModel = { id, name, description?, contextWindow?, efforts?, supportsImages? }`
  - `parseModels(payload: unknown): QoderModel[]`（按场景分组取 `assistant`）
  - `fetchModels(options: { credential, endpoints?, fetchImpl? }): Promise<QoderModel[]>`

- [ ] **Step 1: 写失败测试**

```ts
it('清单按场景分组，取 assistant 那一组', () => {
  const models = parseModels({ assistant: [
    { key: 'qwen3.8-max', display_name: 'Qwen 3.8 Max', is_reasoning: true, max_input_tokens: 1000000, is_vl: true, efforts: ['low', 'high'] },
    { key: 'fast', display_name: 'Fast' },
  ], other: [{ key: 'nope', display_name: 'Nope' }] })
  expect(models.map(m => m.id)).toEqual(['qwen3.8-max', 'fast'])
  expect(models[0]).toMatchObject({ name: 'Qwen 3.8 Max', contextWindow: 1000000, supportsImages: true })
  expect(models[0].efforts).toEqual(['low', 'high'])
})
it('形状不认识时给空清单，不抛错', () => {
  expect(parseModels({})).toEqual([])
  expect(parseModels({ assistant: 'x' })).toEqual([])
})
it('拉清单带上 Bearer 与身份头', async () => {
  const mock = vi.fn().mockResolvedValue(Response.json({ assistant: [{ key: 'm', display_name: 'M' }] }))
  const models = await fetchModels({ credential: { accessToken: 'tok', machineId: 'm' }, fetchImpl: mock })
  expect(mock.mock.calls[0]?.[0]).toBe('https://api3.qoder.sh/api/v2/model/list?Encode=1')
  expect((mock.mock.calls[0]?.[1].headers as Record<string, string>).Authorization).toBe('Bearer tok')
  expect(models.map(m => m.id)).toEqual(['m'])
})
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/qoder-models.spec.ts` → FAIL

- [ ] **Step 3: 实现 `src/qoder/models.ts`**

`parseModels`：顶层取 `assistant` 数组（不是数组则空清单）；每条取 `key` 作 id（空则跳过）、
`display_name` 作 name、`max_input_tokens` 作 contextWindow、`efforts` 作档位、`is_vl` 作 supportsImages。
`fetchModels`：GET `{catalogBase}/api/v2/model/list?Encode=1`，头 `Authorization: Bearer …` +
`qoderIdentityHeaders()` + `Accept: application/json`；非 2xx 抛错（消息只含状态码）。

- [ ] **Step 4: 跑测试确认绿** — PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(qoder): 模型清单的拉取与解析"`

---

### Task 5: 模型请求

**Files:**
- Create: `src/qoder/chat.ts`（已有雏形，本任务接 Task 1/4 的端点与身份头）
- Test: `tests/qoder-chat.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveEndpoints`、`qoderIdentityHeaders`；Task 2 的 `QoderCredential`
- Produces:
  - `buildQoderBody(request: { model, messages?, system?, tools?, maxTokens?, reasoningEffort? }, requestId, sessionId): Record<string, unknown>`
  - `streamQoder(request, deps: { credential, endpoints?, fetchImpl? }): AsyncGenerator<WorkBuddyStreamChunk>`

- [ ] **Step 1: 写失败测试**

```ts
it('请求体带上 metadata.context 与流式开关', () => {
  const body = buildQoderBody({ model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hi' }] }, 'rid', 'sid')
  expect(body.model).toBe('qwen3.8-max')
  expect(body.stream).toBe(true)
  expect(body.stream_options).toEqual({ include_usage: true })
  expect(body.metadata).toEqual({ context: { request_id: 'rid', request_set_id: 'rid', session_id: 'sid', client_type: '5' } })
})
it('请求打对了地址并带齐头', async () => {
  const mock = vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { content: 'ok' } }] }]))
  await collect(streamQoder({ model: 'm', messages: [] }, { credential: async () => ({ accessToken: 'tok', machineId: 'm' }), fetchImpl: mock }))
  const [url, init] = mock.mock.calls[0]!
  expect(url).toBe('https://api2-v2.qoder.sh/model/v1/chat/completions')
  expect(init.headers.Authorization).toBe('Bearer tok')
  expect(init.headers.Accept).toBe('text/event-stream')
  expect(init.headers['X-Request-ID']).toBeTruthy()
  expect(init.headers['X-Session-ID']).toBeTruthy()
})
it('401 时续期一次再重试', async () => { /* 第一次 401，第二次 200；断言续期只发生一次 */ })
it('断流与错误帧都不算成功', async () => {
  await expect(collect(streamQoder(request, { credential: async () => cred, fetchImpl: vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { content: 'x' } }] }])) }))).rejects.toThrow('中断')
})
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/qoder-chat.spec.ts` → FAIL

- [ ] **Step 3: 实现 `src/qoder/chat.ts`**

`buildQoderBody`：model/messages/stream/stream_options/tools/max_tokens/temperature/reasoning_effort +
`metadata.context`（`request_id`/`request_set_id` 用同一个 requestId、`session_id`、`client_type: '5'`）。
`streamQoder`：POST `{modelBase}/model/v1/chat/completions`；头
`Authorization`、`Accept: text/event-stream`、`Content-Type: application/json`、
`X-Request-ID`、`X-Session-ID` + `qoderIdentityHeaders()`；401 时用 `deps.credential(旧令牌)` 续期后重试一次；
SSE 交给仓库已有的 `readSseEvents`/`chunksFromOpenAiEvents`（WorkBuddy 那套）；
流结束没有 `finish_reason` 视为中断 → 抛错。

- [ ] **Step 4: 跑测试确认绿** — PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(qoder): 一次模型请求与错误分类"`

---

### Task 6: 模型行接线与预置

**Files:**
- Create: `src/qoder-model.ts`（已有雏形，本任务接清单发布与端点覆盖）
- Modify: `src/model-plugins.ts`（`qoderModelStream` 传入 `deps`，注册顺序不变）
- Modify: `cordis.patch.yml`（新增 `acp-qoder-global` 行，模型清单改为运行时下发，预置留兜底）
- Modify: `src/health.ts`（期望行）
- Test: `tests/qoder-model.spec.ts`

**Interfaces:**
- Consumes: Task 3 的 `resolveCredential`；Task 4 的 `fetchModels`；Task 5 的 `streamQoder`
- Produces: `qoderModelStream(config, deps?)`（签名与 `workBuddyModelStream` 一致）

- [ ] **Step 1: 写失败测试**

```ts
it('只认 qoder-global 这一行，CN 行不受影响', () => {
  expect(isModelBackedAgent('qoder-global')).toBe(true)
  expect(isModelBackedAgent('qoder')).toBe(false)
  const stream = modelPluginStream({ presets: { g: { agent: 'qoder-global' }, cn: { agent: 'qoder' } } })
  expect(stream('g', request)).toBeDefined()
  expect(stream('cn', request)).toBeUndefined()
})
it('拉到清单后写进运行时账本', async () => { /* 断言 onRuntimeModels 收到清单 */ })
it('清单拉不到时不每轮重试', async () => { /* 连续两次调用只发一次上游请求 */ })
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/qoder-model.spec.ts` → FAIL

- [ ] **Step 3: 实现与接线**

`qoder-model.ts`：认下 `agent === 'qoder-global'`；解析凭据 → 发布清单 → 发模型请求。
清单发布沿用 WorkBuddy 的做法：成功 24 小时 TTL、失败 5 分钟退避（模块级按 presetId 记）。
`cordis.patch.yml`：新增 `acp-qoder-global` 预置行（`agent: qoder-global`、`hideFromRoster: true`），
模型清单只留一条兜底（`auto` 不预设，等运行时下发；若运行时没清单，选择器仍有一项可选）。
`src/health.ts`：期望行加 `acp-qoder-global`。

- [ ] **Step 4: 跑测试确认绿** — PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(qoder): 国际版模型行接线与预置"`

---

### Task 7: 登录路由与设置页

**Files:**
- Create: `src/qoder-route.ts`（已有雏形，本任务接 Task 2/3）
- Create: `src/client/qoder-account-section.tsx`（已有雏形）
- Modify: `package.json`（`exports` 加 `./qoder-login`）
- Modify: `src/client/index.ts`（注册这一节）
- Modify: `cordis.patch.yml`（挂 `acp-agent-qoder-login` 行）
- Test: `tests/qoder-route.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `startLogin`/`pollForToken`；Task 3 的 `readCredential`/`writeCredential`
- Produces: `registerQoderRoutes(ctx, deps?)`；路由 `/acp-agent/qoder-global/session`（GET）与
  `/acp-agent/qoder-global/login`（POST）

- [ ] **Step 1: 写失败测试**

```ts
it('登录路由不泄露凭据，未授权返回 401', async () => {
  const body = (await call(SESSION_PATH, 'GET')).body
  expect(body).not.toContain('secret')
  expect((await call(LOGIN_PATH, 'POST', false)).status).toBe(401)
})
it('同一次登录只发一个授权地址', async () => { /* 两次 POST 得到同一个 URL，轮询只发生一次 */ })
it('路由卸载时中止轮询', async () => { /* dispose 后 abort signal 为 true */ })
```

- [ ] **Step 2: 跑测试确认红** — `npx vitest run tests/qoder-route.spec.ts` → FAIL

- [ ] **Step 3: 实现与接线**

路由沿用 WorkBuddy 的形状：`ctx.effect` 内注册两条精确路径，`ctx.connection.admit` 保护，
GET session 返回 `{ok, authenticated, pending, reason, account?}`，POST login 启动一次设备码流程并返回 `{ok, url}`。
浏览器侧一节：未登录显示「去登录」，登录中显示「等待在浏览器里授权」，已登录显示账号昵称与「退出」。

- [ ] **Step 4: 跑测试确认绿** — PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(qoder): 宿主登录路由与设置页"`

---

### Task 8: 文档、门禁与合并

**Files:**
- Create: `docs/agent-acp/qoder-global.md`
- Modify: `README.md` / `README.zh.md`（agent 清单里加一行）

- [ ] **Step 1: 写文档**

`docs/agent-acp/qoder-global.md`：写清核对时间（2026-11-05）、来源（worker + 本机日志）、
端点表、登录四步、清单形状、请求形状、失败分类、以及**尚未实测**的部分（真机回合、清单里的
真实模型 id、配额口径）。

- [ ] **Step 2: 跑门禁**

Run: `npx tsc --noEmit` → 无输出
Run: `npx vitest run` → 全绿
Run: `npm run build:client` → 产物生成（`lib/client.js` 更新）

- [ ] **Step 3: 提交并合并**

```bash
git add -A && git commit -m "docs(qoder): 国际版接入说明"
git checkout main && git merge --no-ff feat/qoder-international
```

- [ ] **Step 4: 合并后让结果生效**

主工作区重新 `npm run build:client`，并重启桌面 App（源码并回主干不等于界面换了——
浏览器侧加载的是 `lib/client.js` 产物）。

- [ ] **Step 5: 说明真机验收步骤**

请用户在设置页点「去登录」→ 浏览器里授权一次 → 回 DSH 选一个模型发一条消息，
观察是否走通；把结果记回 `docs/agent-acp/qoder-global.md` 的「实测」一节。
