# WorkBuddy 模型插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@goodjin2/dsh-acp-agent` 里加一行「WorkBuddy」模型插件——DSH 自己的循环跑，只把「请求模型」换成 WorkBuddy 账号下的模型（OpenAI 兼容 chat completions）。

**Architecture:** 新增 `src/workbuddy/` 六个小模块（端点、请求体、SSE、一次请求、登录、凭据、清单），外加模型插件入口 `src/workbuddy-model.ts`。凭据由插件自己走 WorkBuddy 的账号登录获得（`/v2/plugin/auth/*` 四个接口），存在 `~/.dsh/workbuddy/credentials.json`（0600），只进内存与该文件，不进日志、不进错误消息、不进路由应答。模型清单登录后从 `/v3/config` 拉，写进目录的运行时账本（目录优先读它），拉不到时退回 preset 行声明的兜底清单。

**Tech Stack:** TypeScript 5.9（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）、Node 22.19+ 内置 `fetch`（不引新依赖）、vitest 3、cordis 4、DSH 宿主插件 API（`webServer` / `connection` / `slots`）。

**Spec:** `docs/superpowers/specs/2026-11-05-workbuddy-model-plugin-design.md`（同分支，先读它；本计划是它的可执行化，冲突以 spec 为准）

## Global Constraints

- 仓库：`/Users/good/github/dsh-plugins/dsh-acp-agent`，工作区 `.worktrees/feat-workbuddy`（分支 `feat/workbuddy-model-plugin`）。所有改动只在这个 worktree 里做。
- 门禁（每个任务结束前跑，全绿才提交）：`pnpm typecheck`、`pnpm test`。改了浏览器半边还要 `pnpm build:client`。
- 不新增依赖：HTTP 用 Node 内置 `fetch`，加解密用 `node:crypto`，文件读写用 `node:fs/promises`。
- 注释、文档、文案一律中文（本仓库惯例）；代码标识符英文。
- 令牌绝不进：日志、错误消息、宿主路由应答、测试快照。沿用 `src/zcode/glm.ts` 的 `scrub` 做法。
- 行 id 一律 `acp-agent-` 前缀；路由路径一律 `/acp-agent/` 前缀。
- preset 行 id `acp-workbuddy`，agent 名 `workbuddy`（目录显示名 `WorkBuddy`）。
- 默认端点 `https://www.workbuddy.cn`；覆盖顺序：preset 配置 → 环境变量 `WORKBUDDY_BASE_URL` → 默认值。登录接口与模型接口必须同源。
- 令牌落盘路径：`${process.env.DSH_HOME ?? join(homedir(), '.dsh')}/workbuddy/credentials.json`，权限 `0600`。
- 单次登录轮询上限 5 分钟；pending 业务码 `11217`。
- 请求超时：沿用 WorkBuddy 自己的口径，首 token 20 分钟（`1200000` ms）。
- 目录里的推理档位轴只认 preset 行声明的 `efforts`（静态）；运行时清单只替换模型条目。
- 一个任务一次提交，提交信息用中文，动词开头（`feat:` / `fix:` / `docs:` / `test:`）。

## Review Focus

下面五条是 spec 说了、但没有哪条任务会顺手测到的输入与故障；每条都指到拥有它的那个任务，任务里必须有钉住它的测试。

1. **未登录就发消息** → 回合必须以「需要登录 WorkBuddy」结束，不能是 401 原文，也不能静默空回答。（Task 5）
2. **令牌出现在错误消息里** → 任何失败路径的消息都不得含 access token / refresh token。（Task 3、Task 5）
3. **工具调用参数分片到达** → 名字在第一帧、参数跨多帧到达时，必须按 index 归并成一个完整调用，不能拼出半截 JSON。（Task 2）
4. **登录站与模型站不同源** → 两者必须来自同一份端点解析结果；用户改了 `WORKBUDDY_BASE_URL` 时两处一起改。（Task 1）
5. **模型清单拉不到**（未登录或网络失败）→ 选择器不能空，退回兜底清单，且不发一个模型请求。（Task 6）

---

## File Structure

新增：

| 文件 | 职责 |
|---|---|
| `src/workbuddy/endpoints.ts` | 端点解析：基址、五个 URL（登录 state/token/refresh、account、config、chat）、环境变量与配置覆盖 |
| `src/workbuddy/openai.ts` | 请求体构造：DSH 消息 → OpenAI chat 消息、工具 → function schema、推理档位映射 |
| `src/workbuddy/sse.ts` | SSE 读取与 OpenAI 增量 → 本仓库块词汇的翻译 |
| `src/workbuddy/chat.ts` | 一次模型请求：拼头、发请求、读流、错误分类与重试 |
| `src/workbuddy/auth.ts` | 登录四步：开始登录、轮询令牌、拉账户、续期 |
| `src/workbuddy/credential.ts` | 凭据存放与解析：内存缓存 + 0600 文件、到期续期、抹除 |
| `src/workbuddy/models.ts` | 模型清单：拉 `/v3/config`、解析、缓存、失败降级 |
| `src/workbuddy/index.ts` | 该目录的公开出口（与 `src/zcode/index.ts` 同款） |
| `src/workbuddy-model.ts` | 模型插件入口（与 `src/zcode-model.ts` 同款） |
| `src/workbuddy-route.ts` | 宿主路由：登录/状态两条 exact 路由（与 `src/zcode-quota.ts` 同款） |
| `src/client/workbuddy-account-section.tsx` | 设置里的「WorkBuddy 账号」段：状态、登录、退出 |

修改：

| 文件 | 改什么 |
|---|---|
| `src/model-plugins.ts` | 插件列表加 WorkBuddy；`MODEL_BACKED_AGENTS` 加 `'workbuddy'`；`modelPluginStream` 多收一个 `deps`（回调：把运行时清单写进目录账本） |
| `src/plugin.ts` / `src/service.ts` | 把 `onRuntimeModels` 回调递给 `modelPluginStream` |
| `src/factory.ts` | 两处「这行不是 ACP 会话」的守卫各加一条 `workbuddy` |
| `src/catalog.ts` | 显示名表加 `workbuddy: 'WorkBuddy'`；`modelStream` 的返回类型并入 WorkBuddy 的块类型 |
| `src/health.ts` | `EXPECTED_ROWS` 加两行（宿主路由行、preset 行） |
| `cordis.patch.yml` | 加宿主路由行 + preset 行 |
| `src/client/index.ts` | 注册设置里的账号段 |
| `src/client/locales.ts` | 新增词条（中英） |

---

### Task 1: 端点解析与请求体构造

**Files:**
- Create: `src/workbuddy/endpoints.ts`
- Create: `src/workbuddy/openai.ts`
- Test: `tests/workbuddy-openai.spec.ts`

**Interfaces:**
- Produces:
  - `endpoints.ts`：
    - `export const DEFAULT_WORKBUDDY_BASE = 'https://www.workbuddy.cn'`
    - `export const WORKBUDDY_BASE_ENV = 'WORKBUDDY_BASE_URL'`
    - `export const WORKBUDDY_AUTH_PREFIX = '/plugin'`
    - `export const WORKBUDDY_PLATFORM = 'workbuddy'`
    - `export type WorkBuddyEndpoints = { readonly base: string; readonly authStateUrl: string; readonly authTokenUrl: string; readonly authRefreshUrl: string; readonly accountUrl: string; readonly configUrl: string; readonly chatUrl: string }`
    - `export function resolveEndpoints(override?: string | undefined, env?: NodeJS.ProcessEnv): WorkBuddyEndpoints`
  - `openai.ts`：
    - `export type WorkBuddyTool = { readonly type: 'function'; readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> } }`
    - `export type WorkBuddyMessage = { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content?: string; readonly tool_calls?: readonly { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }[]; readonly tool_call_id?: string }`
    - `export type WorkBuddyBody = { readonly model: string; readonly messages: readonly WorkBuddyMessage[]; readonly stream: true; readonly tools?: readonly WorkBuddyTool[]; readonly max_tokens?: number; readonly reasoning_effort?: string; readonly temperature?: number }`
    - `export type ChatBodyInput = { readonly model: string; readonly messages: readonly unknown[]; readonly system?: string | undefined; readonly tools?: readonly { readonly name: string; readonly description?: string | undefined; readonly parameters?: unknown }[] | undefined; readonly reasoningEffort?: string | undefined; readonly maxTokens?: number | undefined; readonly supportedEfforts?: readonly string[] | undefined; readonly temperature?: number | undefined; readonly supportsImages?: boolean | undefined }`
    - `export function buildChatBody(input: ChatBodyInput): WorkBuddyBody`
    - `export function resolveReasoningEffort(effort: string | undefined, supported: readonly string[] | undefined): string | undefined`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-openai.spec.ts` 覆盖：

  - `resolveEndpoints(undefined, {})` 的 `base` 是 `https://www.workbuddy.cn`；`chatUrl` 是 `https://www.workbuddy.cn/v2/chat/completions`；`authStateUrl` 是 `https://www.workbuddy.cn/v2/plugin/auth/state`；`authTokenUrl` 是 `https://www.workbuddy.cn/v2/plugin/auth/token`；`authRefreshUrl` 是 `.../v2/plugin/auth/token/refresh`；`accountUrl` 是 `.../v2/plugin/account`；`configUrl` 是 `.../v3/config`。
  - `resolveEndpoints(undefined, { WORKBUDDY_BASE_URL: 'https://copilot.tencent.com' })` 的所有 URL 都换成那个主机（**登录站与模型站同源**：断言 `new URL(authStateUrl).host === new URL(chatUrl).host`）。
  - `resolveEndpoints('https://x.example/', {})`（带尾斜杠）不产生双斜杠。
  - `buildChatBody` 的消息投影：
    - `role: 'system'` 的消息被抽出来成为一条 `role: 'system'` 的消息，且排在最前。
    - `role: 'user'` 文本 → `{ role: 'user', content: '文本' }`。
    - 两条相邻的 `user` 消息合并成一条（内容用 `\n` 连接）。
    - `role: 'assistant'` 且带 `tool-call` 块 → `{ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments } }] }`，`arguments` 是原始 JSON 字符串。
    - `role: 'assistant'` 的 `reasoning` 块**不出现**在结果里。
    - `role: 'tool'` 消息 → `{ role: 'tool', tool_call_id: 'call-1', content: '结果文本' }`。
    - `role: 'user'` 的 `image` 块：`supportsImages` 为真时不算进文本；为假时变成占位文本 `[image attached]`。
  - `buildChatBody` 的工具：`{ name: 'Bash', description: '跑命令', parameters: { type: 'object' } }` → `{ type: 'function', function: { name: 'Bash', description: '跑命令', parameters: { type: 'object' } } }`；`parameters` 缺失时补 `{ type: 'object' }`；`description` 缺失时用工具名。
  - `resolveReasoningEffort('high', ['low','high'])` → `'high'`；档位不在支持列表里 → `undefined`；`supported` 为 `undefined` 时按原样返回（非空、非 none）；`'none'` → `undefined`（关掉思考）。
  - `buildChatBody` 的 `max_tokens`：给了就用（取整），没给则省略该字段。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-openai.spec.ts`
  Expected: FAIL —— `Cannot find module '../src/workbuddy/endpoints.ts'`

- [ ] **Step 3: 实现 `src/workbuddy/endpoints.ts`**

  基址去掉尾斜杠；拼 URL 时用 `${base}/v2/plugin/auth/state` 这类固定后缀。`authTokenUrl` 不带 query（`state` 由调用方按 `?state=` 追加）。

- [ ] **Step 4: 实现 `src/workbuddy/openai.ts`**

  投影规则照 spec §6.2 的表写。`parameters` 用 `JSON.parse` 失败时原样保留字符串（照 `src/zcode/anthropic.ts` 的 `parseInput` 做法）。`exactOptionalPropertyTypes` 开着：可选字段要么不写、要么给值，不能显式 `undefined`。

- [ ] **Step 5: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-openai.spec.ts`
  Expected: PASS

- [ ] **Step 6: 类型检查 + 提交**

  Run: `pnpm typecheck`
  Expected: 无错误

  ```bash
  git add src/workbuddy/endpoints.ts src/workbuddy/openai.ts tests/workbuddy-openai.spec.ts
  git commit -m "feat(workbuddy): 端点解析与 OpenAI 请求体构造"
  ```

---

### Task 2: SSE 解析与增量翻译

**Files:**
- Create: `src/workbuddy/sse.ts`
- Test: `tests/workbuddy-sse.spec.ts`
- Create (fixture): `tests/fixtures/workbuddy-stream.sse.txt`

**Interfaces:**
- Consumes: Task 1 的 `WorkBuddyEndpoints`（本任务不需要）
- Produces:
  - `export type WorkBuddyBlock = { readonly type: 'text'; readonly text: string } | { readonly type: 'reasoning'; readonly text: string } | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }`
  - `export type WorkBuddyUsage = { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number }`
  - `export type WorkBuddyFinish = { readonly kind: 'stop' } | { readonly kind: 'tool-calls' } | { readonly kind: 'max-tokens' } | { readonly kind: 'error'; readonly failure: { readonly message: string; readonly code: string } }`
  - `export type WorkBuddyStreamChunk`（与 `GlmStreamChunk` 同构：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）
  - `export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown>` —— 每帧一个已解析的 JSON
  - `export function chunksFromOpenAiEvents(events: AsyncIterable<unknown>): AsyncGenerator<WorkBuddyStreamChunk>`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-sse.spec.ts` 覆盖：

  - 文本增量：`choices[0].delta.content` 逐帧 → 一个 `block-start`（`blockType: 'text'`）、若干 `text-delta`、一个 `block-end`（`block: { type: 'text', text: 拼起来的全文 }`）。
  - 推理增量：`delta.reasoning_content` → `blockType: 'reasoning'` 的块；`delta.reasoning`（另一种键名）同样认。
  - 工具调用：首帧 `delta.tool_calls[0] = { index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }`，后续帧 `{ index: 0, function: { arguments: '{"cmd":' } }`、再一帧 `{ index: 0, function: { arguments: '"ls"}' } }` → **一个** `tool-call` 块，参数拼成 `{"cmd":"ls"}`（Review Focus 第 3 条）。
  - 两个工具调用交错（index 0 与 index 1）→ 两个独立块，参数各自拼好。
  - `finish_reason: 'tool_calls'` → `finish` 的 `reason.kind` 是 `'tool-calls'`；`'stop'` → `'stop'`；`'length'` → `'max-tokens'`。
  - `usage` 帧（`prompt_tokens` / `completion_tokens` / `total_tokens`）→ 一条 `usage` 块。
  - `[DONE]` 结束流；畸形帧（不是 JSON 的 `data:`）被跳过，不抛。
  - 流里没有任何 `choices` 的帧（例如心跳）不产出块。

  夹具 `tests/fixtures/workbuddy-stream.sse.txt` 放一段完整的 SSE 文本（文本 + 工具调用 + usage + `[DONE]`），测试从文件读它跑一遍，钉住整条流的块序列。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-sse.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/workbuddy/sse.ts`**

  `readSseEvents` 照 `src/zcode/sse.ts` 的形状（`TextDecoder` + `\n\n` 分帧 + `data:` 前缀剥离），但产出 `JSON.parse` 后的对象；解析失败就跳过该帧。`chunksFromOpenAiEvents` 按 index 维护进行中的块：文本一个块、推理一个块、每个工具调用一个块；工具调用块的参数用字符串拼接。

- [ ] **Step 4: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-sse.spec.ts`
  Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

  Run: `pnpm typecheck`

  ```bash
  git add src/workbuddy/sse.ts tests/workbuddy-sse.spec.ts tests/fixtures/workbuddy-stream.sse.txt
  git commit -m "feat(workbuddy): SSE 解析与增量翻译"
  ```

---

### Task 3: 一次模型请求（URL、头、体、错误分类）

**Files:**
- Create: `src/workbuddy/chat.ts`
- Test: `tests/workbuddy-chat.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveEndpoints` / `WorkBuddyEndpoints` / `buildChatBody`；Task 2 的 `readSseEvents` / `chunksFromOpenAiEvents` / `WorkBuddyStreamChunk`
- Produces:
  - `export type WorkBuddyChatRequest = { readonly model: string; readonly messages: readonly unknown[]; readonly tools?: readonly { readonly name: string; readonly description?: string | undefined; readonly parameters?: unknown }[] | undefined; readonly system?: string | undefined; readonly reasoningEffort?: string | undefined; readonly supportedEfforts?: readonly string[] | undefined; readonly maxTokens?: number | undefined; readonly accessToken: string; readonly account?: { readonly uid: string; readonly enterpriseId?: string | undefined } | undefined; readonly conversationId?: string | undefined; readonly requestId?: string | undefined; readonly messageId?: string | undefined; readonly signal?: AbortSignal | undefined; readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined; readonly onUnauthorized?: (() => Promise<string | undefined>) | undefined }`
  - `export async function* streamWorkBuddy(request: WorkBuddyChatRequest): AsyncGenerator<WorkBuddyStreamChunk>`
  - `export const TRANSPORT_FAILURE_CODE = 'TRANSPORT'`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-chat.spec.ts` 用一个假 `fetchImpl` 覆盖：

  - 请求打到 `https://www.workbuddy.cn/v2/chat/completions`，method 是 POST。
  - 请求头含 `authorization: 'Bearer TOKEN'`、`accept: 'text/event-stream'`、`content-type: 'application/json'`、`x-user-id: 'uid-1'`；有企业 id 时含 `x-enterprise-id`；有会话 id 时含 `x-conversation-id` 与 `x-request-id`。
  - 请求体是 `buildChatBody` 的产物（`stream: true`、`model` 对、`tools` 形状对）。
  - 200 + SSE 夹具 → 块序列与 Task 2 的翻译结果一致。
  - 401 → 调用 `onUnauthorized` 一次并用新令牌重试一次；第二次仍 401 → 抛错，错误消息里**不含** `TOKEN`（Review Focus 第 2 条）。
  - 429 → 不重试，抛错，消息含状态码。
  - 500 → 重试两次后放弃（共 3 次请求）。
  - `fetchImpl` 抛错 → 产出一个 `finish` 块，`reason.kind === 'error'`、`reason.failure.code === 'TRANSPORT'`。
  - 响应不是 SSE（普通 JSON） → 抛错，消息含状态码与响应体前若干字，且不含令牌。
  - `signal` 中止 → 迭代器抛出 `AbortError`。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-chat.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/workbuddy/chat.ts`**

  头名用小写（`authorization` / `x-user-id` / `x-conversation-id` / `x-request-id` / `x-message-id` / `x-enterprise-id`），值取自 `request`。重试策略：5xx 最多再试 2 次（退避 200ms / 800ms，测试里用可注入的 `sleepImpl` 或把退避设成 0——**退避时长做成模块内常量，测试用 fake timers**）；429 与 4xx 不重试。错误消息统一过一遍抹除（把 `accessToken` 与刷新令牌替换成 `[redacted]`）。

- [ ] **Step 4: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-chat.spec.ts`
  Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

  Run: `pnpm typecheck`

  ```bash
  git add src/workbuddy/chat.ts tests/workbuddy-chat.spec.ts
  git commit -m "feat(workbuddy): 一次模型请求与错误分类"
  ```

---

### Task 4: 登录流程

**Files:**
- Create: `src/workbuddy/auth.ts`
- Test: `tests/workbuddy-auth.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveEndpoints` / `WorkBuddyEndpoints`
- Produces:
  - `export const LOGIN_PENDING_CODE = 11217`
  - `export type WorkBuddyLoginStart = { readonly state: string; readonly url: string }`
  - `export type WorkBuddyCredential = { readonly accessToken: string; readonly refreshToken?: string | undefined; readonly expiresAt?: number | undefined; readonly account?: WorkBuddyAccount | undefined }`
  - `export type WorkBuddyAccount = { readonly uid: string; readonly nickname?: string | undefined; readonly enterpriseId?: string | undefined }`
  - `export async function startLogin(options?: { readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined }): Promise<WorkBuddyLoginStart>`
  - `export async function pollForToken(options: { readonly state: string; readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined; readonly timeoutMs?: number | undefined; readonly intervalMs?: number | undefined; readonly signal?: AbortSignal | undefined }): Promise<WorkBuddyCredential>`
  - `export async function refreshSession(options: { readonly refreshToken: string; readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined }): Promise<WorkBuddyCredential>`
  - `export async function fetchAccount(options: { readonly accessToken: string; readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined }): Promise<WorkBuddyAccount>`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-auth.spec.ts` 覆盖：

  - `startLogin`：`POST {base}/v2/plugin/auth/state?platform=workbuddy`，请求头带 `x-no-authorization` / `x-no-user-id` / `x-no-enterprise-id` / `x-no-department-info` 各为 `'true'`，`x-domain` 是基址主机名；响应 `data.data = { state, authUrl }` → 返回 `{ state, url: authUrl }`。
  - `startLogin` 响应缺少 `authUrl` → 抛错，消息说明登录地址没拿到。
  - `pollForToken`：第一次返回 `{ code: 11217, msg: 'login ing...' }`，第二次返回 `{ code: 0, data: { data: { accessToken: 'A', refreshToken: 'R', expiresIn: 3600 } } }` → 返回 `{ accessToken: 'A', refreshToken: 'R', expiresAt: 期望的毫秒时间戳 }`；轮询请求打 `{base}/v2/plugin/auth/token?state=<state>`。
  - `pollForToken` 一直 pending 直到超时 → 抛错（消息说明没等到登录）。
  - `pollForToken` 拿到非 pending 的业务错误码 → 直接抛错，不继续等。
  - `refreshSession`：`POST {base}/v2/plugin/auth/token/refresh`，请求头 `x-refresh-token: 'R'`、`x-auth-refresh-source: 'plugin'` → 返回新令牌。
  - `fetchAccount`：`GET {base}/v2/plugin/account`，头 `authorization: 'Bearer A'` → 返回 `{ uid, nickname, enterpriseId }`；响应缺 `data.data` → 抛错。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-auth.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/workbuddy/auth.ts`**

  响应外壳是 `{ code, msg, data: { data: ... } }`——**真正的业务内容在 `data.data` 里**，别读错一层。pending 判定：`code === 11217`（同时兼容 `msg` 里含「登录中」的形态，但以 code 为准）。轮询间隔默认 2 秒，上限默认 5 分钟（`timeoutMs` / `intervalMs` 可注入，测试传小值）。

- [ ] **Step 4: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-auth.spec.ts`
  Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

  Run: `pnpm typecheck`

  ```bash
  git add src/workbuddy/auth.ts tests/workbuddy-auth.spec.ts
  git commit -m "feat(workbuddy): 账号登录、轮询与续期"
  ```

---

### Task 5: 凭据存放与解析

**Files:**
- Create: `src/workbuddy/credential.ts`
- Test: `tests/workbuddy-credential.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `refreshSession` / `fetchAccount` / `WorkBuddyCredential` / `WorkBuddyAccount`
- Produces:
  - `export class WorkBuddyAuthRequiredError extends Error {}`
  - `export type CredentialStoreOptions = { readonly file?: string | undefined; readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined; readonly env?: NodeJS.ProcessEnv | undefined }`
  - `export function credentialFilePath(env?: NodeJS.ProcessEnv): string`
  - `export function readStoredCredential(file?: string): Promise<WorkBuddyCredential | undefined>`
  - `export async function writeStoredCredential(credential: WorkBuddyCredential, file?: string): Promise<void>` —— 写 0600
  - `export async function clearStoredCredential(file?: string): Promise<void>`
  - `export function credentialResolver(options?: CredentialStoreOptions): () => Promise<WorkBuddyCredential>` —— 没登录就抛 `WorkBuddyAuthRequiredError`；快过期（< 60 秒）先续期；续期后仍失败 → 抛 `WorkBuddyAuthRequiredError`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-credential.spec.ts` 覆盖（用临时目录，测完清理）：

  - `credentialFilePath({})` 是 `<home>/.dsh/workbuddy/credentials.json`；`credentialFilePath({ DSH_HOME: '/tmp/x' })` 是 `/tmp/x/workbuddy/credentials.json`。
  - `writeStoredCredential` 之后文件存在，权限是 `0600`（`stat.mode & 0o777`）。
  - `readStoredCredential` 能读回刚写的（往返一致）；文件不存在时返回 `undefined` 而不是抛错。
  - 没有凭据时 `credentialResolver()` 抛 `WorkBuddyAuthRequiredError`，消息含「登录」（Review Focus 第 1 条）。
  - 凭据剩余有效期不足 60 秒 → 先调 `refreshSession` 再返回新令牌，并把新令牌写回文件。
  - 续期失败（刷新令牌也过期）→ 抛 `WorkBuddyAuthRequiredError`。
  - 续期成功但 `fetchAccount` 失败 → 仍返回凭据（账户信息可有可无，不因此失败）。
  - **任何错误消息都不含令牌明文**（Review Focus 第 2 条）：造一个失败场景，断言消息里没有 `accessToken` 的值。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-credential.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/workbuddy/credential.ts`**

  写文件用 `writeFile(path, data, { mode: 0o600 })`，写前 `mkdir(dirname, { recursive: true, mode: 0o700 })`；已存在的文件先 `chmod` 一次再写（`writeFile` 的 `mode` 对已存在文件不生效）。抹除函数：把令牌串替换成 `[redacted]`（照 `src/zcode/glm.ts` 的 `scrub`）。

- [ ] **Step 4: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-credential.spec.ts`
  Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

  Run: `pnpm typecheck`

  ```bash
  git add src/workbuddy/credential.ts tests/workbuddy-credential.spec.ts
  git commit -m "feat(workbuddy): 凭据存放、续期与需要登录的状态"
  ```

---

### Task 6: 模型清单

**Files:**
- Create: `src/workbuddy/models.ts`
- Test: `tests/workbuddy-models.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveEndpoints` / `WorkBuddyEndpoints`；Task 5 的凭据
- Produces:
  - `export type WorkBuddyModel = { readonly id: string; readonly name: string; readonly description?: string | undefined; readonly contextWindow?: number | undefined; readonly efforts?: readonly string[] | undefined; readonly supportsToolCall?: boolean | undefined; readonly supportsImages?: boolean | undefined }`
  - `export async function fetchModels(options: { readonly credential: WorkBuddyCredential; readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined }): Promise<WorkBuddyModel[]>`
  - `export function parseModels(payload: unknown): WorkBuddyModel[]` —— 从 `/v3/config` 的响应里取 `data.models`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-models.spec.ts` 覆盖：

  - `parseModels` 从 `data.models` 里读出每项的 `id` / `name`；描述取 `descriptionZh`，没有则 `descriptionEn`；`maxInputTokens` → `contextWindow`；`reasoning.supportedEfforts` → `efforts`；`supportsToolCall` / `supportsImages` 原样。
  - `reasoning` 只有 `defaultEffort` 没有 `supportedEfforts` 时，`efforts` 是 `[defaultEffort]`。
  - `data.models` 缺失或不是数组 → 返回 `[]`（不抛）。
  - `fetchModels` 打到 `{base}/v3/config`，请求头含 `__codebuddyProductConfigurationRequest: 'true'` 与 `authorization: 'Bearer A'`。
  - `fetchModels` 拿到 401 → 抛错，消息不含令牌。
  - **拉不到清单时不发模型请求**（Review Focus 第 5 条）：由 Task 7 的入口保证——这里只需保证 `fetchModels` 失败会抛错而不是返回半份清单。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-models.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/workbuddy/models.ts`**

  只取需要的字段，不整份透传（目录里显示的是名字与描述，倍率信息放进描述文本）。

- [ ] **Step 4: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-models.spec.ts`
  Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

  Run: `pnpm typecheck`

  ```bash
  git add src/workbuddy/models.ts tests/workbuddy-models.spec.ts
  git commit -m "feat(workbuddy): 模型清单的拉取与解析"
  ```

---

### Task 7: 模型插件入口与目录接线

**Files:**
- Create: `src/workbuddy-model.ts`
- Create: `src/workbuddy/index.ts`
- Modify: `src/model-plugins.ts`
- Modify: `src/plugin.ts`
- Modify: `src/service.ts`
- Modify: `src/factory.ts`
- Modify: `src/catalog.ts`
- Test: `tests/workbuddy-model-plugin.spec.ts`
- Modify: `tests/model-plugins.spec.ts`

**Interfaces:**
- Consumes: Task 1–6 全部（`buildChatBody`、`streamWorkBuddy`、`credentialResolver`、`fetchModels`、`WorkBuddyStreamChunk`）
- Produces:
  - `src/workbuddy/index.ts` 重新导出该目录的公开符号（与 `src/zcode/index.ts` 同款）
  - `src/workbuddy-model.ts`：
    - `export function workBuddyModelStream(config: PresetConfig, deps?: { readonly onRuntimeModels?: ((presetId: string, models: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]) => void) | undefined }): (presetId: string, request: CatalogTurnRequest) => AsyncIterable<WorkBuddyStreamChunk> | undefined`
  - `src/model-plugins.ts`：`modelPluginStream(config, deps?)` 多收第二个参数；插件列表加 WorkBuddy；`MODEL_BACKED_AGENTS` 加 `'workbuddy'`
  - `src/plugin.ts` / `src/service.ts`：把 `onRuntimeModels` 回调递给 `modelPluginStream`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-model-plugin.spec.ts` 覆盖：

  - `workBuddyModelStream(config)` 对 `agent !== 'workbuddy'` 的 preset 返回 `undefined`；对 `agent === 'workbuddy'` 的 preset 返回可迭代对象。
  - 迭代产出的块是 `WorkBuddyStreamChunk` 形状（断言 `type` 字段取值）。
  - **工具调用与工具结果重新配对**：`src/model-plugins.ts` 里的 `withPairedResults` 对 WorkBuddy 同样生效——断言传给 `buildChatBody` 的消息里，工具结果紧跟在对应工具调用之后（照 `tests/model-plugin-pairing.spec.ts` 的写法）。
  - 运行时清单写进账本：入口在首次取用时拉一次 `/v3/config`，并调用 `deps.onRuntimeModels(presetId, models)` 一次（Review Focus 第 5 条）。
  - 拉清单失败时**不**调用 `onRuntimeModels`（保留兜底清单），并且**不**因此发不出模型请求（模型请求照常发）。

  `tests/model-plugins.spec.ts` 补一条：`modelPluginStream(config)('acp-workbuddy', request)` 有定义；`modelPluginStream(config)('acp-codex', request)` 仍是 `undefined`。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-model-plugin.spec.ts tests/model-plugins.spec.ts`
  Expected: FAIL —— 入口不存在

- [ ] **Step 3: 实现 `src/workbuddy-model.ts` 与 `src/workbuddy/index.ts`**

  入口形状照 `src/zcode-model.ts`：认下 `config.presets[presetId]?.agent === 'workbuddy'`，把 `CatalogTurnRequest` 的 `model` / `messages` / `tools` / `system` / `reasoningEffort` / `maxTokens` / `signal` 翻译成 `streamWorkBuddy` 的入参；凭据用 `credentialResolver()` 取，取不到就让错误冒上去（宿主会显示「需要登录」）。

- [ ] **Step 4: 接线：`src/model-plugins.ts`、`src/plugin.ts`、`src/service.ts`、`src/factory.ts`、`src/catalog.ts`**

  - `model-plugins.ts`：`plugins` 数组加 `workBuddyModelStream(config, deps)`；`MODEL_BACKED_AGENTS` 加 `'workbuddy'`；`modelPluginStream(config, deps?)` 的第二个参数透传给各插件。
  - `plugin.ts`：`modelStream: modelPluginStream(presets, { onRuntimeModels: (presetId, models) => runtimeModelReports.record(presetId, models) })`。
  - `service.ts`：同样把 `onRuntimeModels` 接上（这个文件里也有一份 `runtimeModelReports`）。
  - `factory.ts`：两处守卫各加 `workbuddy`（照 `zcode`/`minimaxi` 的写法与措辞）。
  - `catalog.ts`：`DISPLAY` 加 `workbuddy: 'WorkBuddy'`；`CatalogDeps.modelStream` 的返回类型并入 `WorkBuddyStreamChunk`（三个块的联合类型）。

- [ ] **Step 5: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-model-plugin.spec.ts tests/model-plugins.spec.ts`
  Expected: PASS

- [ ] **Step 6: 全量测试 + 类型检查 + 提交**

  Run: `pnpm test && pnpm typecheck`
  Expected: 全绿

  ```bash
  git add src/workbuddy-model.ts src/workbuddy/index.ts src/model-plugins.ts src/plugin.ts src/service.ts src/factory.ts src/catalog.ts tests/workbuddy-model-plugin.spec.ts tests/model-plugins.spec.ts
  git commit -m "feat(workbuddy): 模型插件入口与目录接线"
  ```

---

### Task 8: 宿主路由（登录与状态）

**Files:**
- Create: `src/workbuddy-route.ts`
- Modify: `src/health.ts`
- Test: `tests/workbuddy-route.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `startLogin` / `pollForToken` / Task 5 的 `credentialResolver` / `writeStoredCredential`
- Produces:
  - `export const name = 'acp-agent-workbuddy-login'`
  - `export const inject = ['webServer', 'connection']`
  - `export const WORKBUDDY_SESSION_ROUTE_PATH = '/acp-agent/workbuddy/session'`
  - `export const WORKBUDDY_LOGIN_ROUTE_PATH = '/acp-agent/workbuddy/login'`
  - `export function apply(ctx: WorkBuddyRouteContext): void`
  - `export type WorkBuddyRouteContext` —— 照 `src/zcode-quota.ts` 的 `ZcodeQuotaContext` 形状（`effect` / `webServer.register` / `connection.admit`）

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-route.spec.ts` 覆盖（照 `tests/zcode-quota.spec.ts` 的立桩方式）：

  - 路由注册了两条 exact 路径，路径常量与上面一致。
  - `GET /acp-agent/workbuddy/session`：已登录 → `{ ok: true, authenticated: true, account: { uid, nickname } }`；未登录 → `{ ok: true, authenticated: false, needsLogin: true }`。
  - `POST /acp-agent/workbuddy/login`：返回 `{ ok: true, url: 'https://…/login?…' }`，**应答里没有任何令牌**。
  - 准入被拒（`connection.admit` 返回 rejection）→ 状态码原样、短体固定。
  - 登录失败 → `200` + `{ ok: false, reason: '…' }`，不甩 500，且消息里不含令牌。
  - **路由应答不含令牌**（Review Focus 第 2 条）：断言应答体里没有 access token 的值。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-route.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/workbuddy-route.ts`**

  照 `src/zcode-quota.ts` 的形状：`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))`。登录路由内部启动一次轮询（上限 5 分钟），成功就把凭据写盘；轮询没完成就返回 pending 状态（`{ ok: true, pending: true }`），由客户端再问一次 session。

- [ ] **Step 4: `src/health.ts` 加期望行**

  `EXPECTED_ROWS` 加两行：`{ id: 'acp-agent-workbuddy-login', what: 'WorkBuddy 登录与状态接口' }` 与 `{ id: 'acp-workbuddy', what: 'WorkBuddy 预置' }`。

- [ ] **Step 5: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-route.spec.ts tests/health.spec.ts`
  Expected: PASS

- [ ] **Step 6: 类型检查 + 提交**

  Run: `pnpm typecheck`

  ```bash
  git add src/workbuddy-route.ts src/health.ts tests/workbuddy-route.spec.ts
  git commit -m "feat(workbuddy): 宿主登录与状态路由"
  ```

---

### Task 9: 挂载配置（patch 行）

**Files:**
- Modify: `cordis.patch.yml`
- Create: `tests/workbuddy-patch.spec.ts`（照 `tests/client-roster-row.spec.ts` 的做法：读 `cordis.patch.yml` 文本）

**Interfaces:**
- Consumes: Task 8 的路由常量（路径要一致）
- Produces: patch 里两行——宿主路由行 `acp-agent-workbuddy-login`（name `@goodjin2/dsh-acp-agent/workbuddy-login`）与 preset 行 `acp-workbuddy`

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-patch.spec.ts` 读 `cordis.patch.yml`（`readFileSync` + 正则，照 `tests/client-roster-row.spec.ts` 的做法），断言：

  - 有一条 preset 行 `id: acp-workbuddy`，`name: WorkBuddy`，绑定里 `agent: workbuddy`。
  - 这一行声明了 `efforts`（至少 `low`/`medium`/`high` 三档）与 `models`（至少 `auto`、`fast-model`、`balanced-model`、`deep-model` 四个条目，各带 id 与 name）。
  - 有一条宿主路由行 `id: acp-agent-workbuddy-login`，`name` 以 `@goodjin2/dsh-acp-agent/` 开头。
  - **patch 里出现的行 id 与 `src/health.ts` 的 `EXPECTED_ROWS` 一一对应**（缺一个就红——这是仓库既有规矩）。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-patch.spec.ts`
  Expected: FAIL —— 行不存在

- [ ] **Step 3: 改 `cordis.patch.yml`**

  按现有几行的写法加两行。preset 行：

  - `id: acp-workbuddy`，`name: WorkBuddy`，`order: 55`（排在现有 `acp-qoder` 的 50 之后）。
  - 绑定：`presetId: acp-workbuddy`、`agent: workbuddy`、`hideFromRoster: true`。
  - `efforts`：`low` / `medium` / `high`（WorkBuddy 模型接受的档位；抓包后按真机修正）。
  - `models`（兜底清单）：`auto`（Auto）、`fast-model`（快速）、`balanced-model`（均衡）、`deep-model`（极致），各带一句描述（把倍率与「自动选模」的语义写进去）。

  宿主路由行照现有 quota 行的写法，`name: '@goodjin2/dsh-acp-agent/workbuddy-login'`。

- [ ] **Step 4: 跑测试，确认通过**

  Run: `pnpm vitest run tests/workbuddy-patch.spec.ts tests/health.spec.ts`
  Expected: PASS

- [ ] **Step 5: 提交**

  ```bash
  git add cordis.patch.yml tests/workbuddy-patch.spec.ts
  git commit -m "feat(workbuddy): 挂载配置与兜底模型清单"
  ```

---

### Task 10: 浏览器侧的账号段

**Files:**
- Create: `src/client/workbuddy-account-section.tsx`
- Modify: `src/client/index.ts`
- Modify: `src/client/locales.ts`
- Test: `tests/workbuddy-account-section.spec.ts`

**Interfaces:**
- Consumes: Task 8 的两条路由路径常量（客户端用字面量路径字符串，照 `src/client/quota-pill.ts` 里 `QUOTA_ROUTE_PATH` 的做法）
- Produces:
  - `export const WORKBUDDY_ACCOUNT_SECTION_ID = 'acp-agent-workbuddy-account'`
  - `export function registerWorkBuddyAccountSection(slots: WorkBuddyAccountSlotHost, label: () => string): void`
  - `export function workBuddyAccountView(props: WorkBuddyAccountProps): ReactElement` —— 纯视图，方便单测直接断言

- [ ] **Step 1: 写失败测试**

  `tests/workbuddy-account-section.spec.ts` 覆盖：

  - 视图在「未登录」时渲染一个「去授权」按钮（可断言按钮的 `data-workbuddy-login` 属性）。
  - 视图在「已登录」时渲染账号昵称与 uid，**不**渲染登录按钮。
  - 点「去授权」时调用 `POST /acp-agent/workbuddy/login`，并把返回的 `url` 交给注入的 `openUrl`（测试里断言 `openUrl` 收到的就是那个地址；不真的开窗）。
  - 点「刷新状态」时调用 `GET /acp-agent/workbuddy/session`，并按应答重画。
  - **应答里没有令牌时视图也不需要令牌**：断言渲染过程不读任何令牌字段。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `pnpm vitest run tests/workbuddy-account-section.spec.ts`
  Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/client/workbuddy-account-section.tsx`**

  照 `src/client/acp-visibility-panel.tsx` 的注册方式：`slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: WORKBUDDY_ACCOUNT_SECTION_ID, order: 40, label, locale: NAMESPACE, inject: () => face }, WorkBuddyAccountSection))`。网络请求用 `fetch`；开链接用 `window.open(url, '_blank', 'noopener')`（测试注入假实现）。

- [ ] **Step 4: 接线 `src/client/index.ts` 与 `src/client/locales.ts`**

  在 `apply` 里 `safeRegister('workbuddy account section', () => registerWorkBuddyAccountSection(...))`。词条加中文与英文各一套（键名 `workbuddy.section.*`、`workbuddy.login.*`、`workbuddy.loggedIn.*`），照 `src/client/locales.ts` 现有写法。

- [ ] **Step 5: 跑测试 + 重建浏览器产物**

  Run: `pnpm vitest run tests/workbuddy-account-section.spec.ts && pnpm build:client`
  Expected: PASS；`lib/client.js` 重新生成。

- [ ] **Step 6: 提交**

  `lib/` 在 `.gitignore` 里（浏览器产物是构建出来的，不入库），所以只提交源码与测试：

  ```bash
  git add src/client/workbuddy-account-section.tsx src/client/index.ts src/client/locales.ts tests/workbuddy-account-section.spec.ts
  git commit -m "feat(workbuddy): 设置里的账号段与去授权入口"
  ```

---

### Task 11: 文档

**Files:**
- Create: `docs/agent-acp/workbuddy.md`
- Modify: `docs/agent-acp/README.md`
- Modify: `README.md` / `README.zh.md`（若有「有几行 agent」的清单）

**Interfaces:**
- Consumes: 前面所有任务的最终形态
- Produces: 无代码接口

- [ ] **Step 1: 写文档**

  `docs/agent-acp/workbuddy.md` 按现有几篇的体例：

  - 一句话结论 + 核对时间（2026-11-05）。
  - 怎么跑起来：它不走 ACP，是模型插件；凭据从哪来；端点怎么配。
  - 请求模型的全过程：登录四步 → 清单 → 请求 → 续期（配一张接口表）。
  - 最容易踩的坑（照现有文档的路数写）：未登录的表现、401 的两种含义、端点不同源、令牌泄漏的防线。
  - 「哪里还没确认」：真机抓包后补齐的字段。

  `docs/agent-acp/README.md` 的对照表加一行 WorkBuddy，并标注「模型插件，不走 ACP」；那句「zcode 与 minimaxi 不在下面的字段对照表里」要一并更新（现在有三个这样的行）。

- [ ] **Step 2: 跑测试（文档里有测试断言清单的话）**

  Run: `pnpm test`
  Expected: 全绿

- [ ] **Step 3: 提交**

  ```bash
  git add docs/agent-acp/workbuddy.md docs/agent-acp/README.md README.md README.zh.md
  git commit -m "docs(workbuddy): 接入说明与对照表"
  ```

---

### Task 12: 真机验收与抓包存档

**Files:**
- Modify: `tests/fixtures/workbuddy-stream.sse.txt`（用真机抓包替换手写夹具）
- Create: `tests/workbuddy-live.spec.ts`（照 `tests/live.spec.ts` 的写法，默认不跑）

**Interfaces:**
- Consumes: 全部
- Produces: 真机夹具 + 一条真机验收记录

- [ ] **Step 1: 真机抓包**

  用真账号跑一次完整回合（发一句话 → 模型要工具 → 执行 → 再问 → 收尾），把模型请求的响应体原样存进 `tests/fixtures/workbuddy-stream.sse.txt`，把请求头与请求体里**去掉令牌**后存进 `tests/fixtures/workbuddy-request.json`。

- [ ] **Step 2: 用真机夹具替换手写夹具**

  跑 `pnpm vitest run tests/workbuddy-sse.spec.ts`；若断言与真机形状不符，**以真机为准**修解析器（不是改夹具迁就实现），并在 `docs/agent-acp/workbuddy.md` 记下差异。

- [ ] **Step 3: 写一条真机验收测试**

  `tests/workbuddy-live.spec.ts` 照 `tests/live.spec.ts` 的约定：默认跳过，需要显式开关才跑（不引第三方依赖，用 `process.env` 开关）。它做的事：解析凭据 → 拉清单 → 发一句话 → 断言收到文本块。

- [ ] **Step 4: 桌面版验证**

  把插件的 `cordis.patch.yml` 的 insert 段并进本机桌面 profile（`~/.dsh/profiles/desktop/cordis.patch.yml`），重启桌面 App，确认：

  - 模型选择器里出现 WorkBuddy 分组。
  - 设置里出现「WorkBuddy 账号」段，能登录、能发消息。
  - 宿主启动日志里 `EXPECTED_ROWS` 全是 `mounted`（缺行会在这里露出来）。

- [ ] **Step 5: 提交**

  ```bash
  git add tests/fixtures/workbuddy-stream.sse.txt tests/fixtures/workbuddy-request.json tests/workbuddy-live.spec.ts
  git commit -m "test(workbuddy): 真机抓包存档与真机验收用例"
  ```

---

## 自查记录

写完后对着 spec 逐条过了一遍：

- spec §3（事实依据）→ Task 1/4/6 的实现依据，已在任务里写成钉死的断言。
- spec §4（架构）→ File Structure 与 Task 1–8 的文件划分一致。
- spec §5（凭据）→ Task 4/5/8。
- spec §6（模型请求）→ Task 1/2/3。
- spec §7（模型清单）→ Task 6/7（并按 spec 修正后的口径：档位静态、模型条目运行时）。
- spec §8（接线）→ Task 7/8/9。
- spec §9（浏览器侧）→ Task 10。
- spec §10（测试与门禁）→ 每个任务自带测试步骤 + Task 12 真机。
- spec §11（风险）→ 风险 1（协议可能有私有扩展）落在 Task 12；风险 2（登录与模型分层测）落在 Task 4/5/12；风险 3（同源）落在 Task 1；风险 4（令牌泄漏）落在 Task 3/5/8；风险 5（计费）落在 Task 6/9 的描述文案。
- spec §12（未决问题）→ 端点偏向留给部署方（Task 1 的覆盖顺序）；积分余额接口明确不做（spec §2 已排除）；`auto` 条目当普通条目（Task 9 的兜底清单）。

Review Focus 五条分别落在：Task 5（第 1、2 条）、Task 2（第 3 条）、Task 1（第 4 条）、Task 6/7（第 5 条）。
