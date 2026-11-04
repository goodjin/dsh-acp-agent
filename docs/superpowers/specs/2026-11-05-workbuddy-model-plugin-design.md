# WorkBuddy 模型插件（Agent-acp 新增一行）设计

> 核对时间：2026-11-05
> 状态：设计已评审通过，待出实施计划
> 归属仓库：`@goodjin2/dsh-acp-agent`（本文件在 `feat/workbuddy-model-plugin` 分支的 worktree 里）

## 一、背景与目标

WorkBuddy 是腾讯 CodeBuddy 的桌面版。它的 agent 内核是一个 Node 写的 CLI（`@genie/agent-cli` v2.165.0，对外包名 `@tencent-ai/codebuddy-code`）。我们逆向看了它怎么向模型发请求，结论是：**协议本身是标准 OpenAI Chat Completions（流式 SSE），没有私有协议**；私有的是外壳——端点、鉴权、附加头、模型清单与账号体系。

目标：在本仓库新增一行「WorkBuddy」，做成**模型插件**（与已有的 `zcode`、`minimaxi` 同构）：

- DSH 自己的循环、自己的工具、自己的审批、自己的取消、自己的会话记录，全部不变。
- 只有「向模型要下一句话」这一步换成 WorkBuddy 账号下的模型。
- 模型选择器里多出一个 WorkBuddy 分组。

**成功标准**：用户在 DSH 里选 WorkBuddy 的某个模型发一句话，DSH 用 WorkBuddy 的账号把这句话送到 WorkBuddy 的模型端点，流式拿回文本、推理与工具调用，工具由 DSH 执行，回合正常收尾。

## 二、范围

### 做

- WorkBuddy 账号登录（插件自己走，浏览器授权）。
- 令牌存储、自动续期、失效后的「需要登录」状态。
- 模型请求（OpenAI 兼容 chat completions，流式）。
- 模型清单（登录后从服务端拉，未登录时用配置里的兜底清单）。
- 浏览器侧一枚「去授权」入口。

### 不做（留给下一版）

- 不接 WorkBuddy 的工具、会话历史、子代理、模式切换。
- 不做 WorkBuddy 的配额/积分胶囊。
- 不复用 WorkBuddy 桌面版或 CLI 的登录态（那是加密存放的，见风险一）。

## 三、事实依据

以下结论来自对 `/Applications/WorkBuddy.app` 内 `app.asar` 的解包（CLI 主体 `cli/dist/codebuddy-lite-wb.mjs`，约 9.8MB 压缩 JS）与本机实测。

### 3.1 模型请求

| 项 | 结论 | 证据 |
|---|---|---|
| 协议 | OpenAI Chat Completions，流式 SSE | CLI 内置官方 `openai` npm 包，`chat.completions.create({...t, stream: true})` |
| 地址 | `{端点}/v2/chat/completions` | `resolveModelBaseURL` 返回 `${endpoint}/v2`，再由 SDK 追加 `/chat/completions`；平台模型的 `url` 由服务端 `/v3/config` 下发 |
| 客户端 | 官方 openai 包，但 `fetch` 被换成自己的 axios 适配器 | `buildOpenAIClientOptions` → `{baseURL, apiKey, fetch: this.axiosToFetchAdapter(), maxRetries: 0, timeout: 1200000}` |
| 鉴权 | `Authorization: Bearer <accessToken>` | 适配器里 `N[HttpHeaders.AUTHORIZATION] = \`Bearer ${en.auth.accessToken}\`` |
| 附加头 | 一整套会话/遥测头 | 模块 63355 定义：`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Request-ID`、`X-Agent-Intent`（默认 `craft`）、`X-Agent-Runtime`、`X-Agent-Type`、`X-Product`、`X-IDE-Type/Name/Version`、`X-User-Id`、`X-Enterprise-Id`、`X-API-Key`、`X-Private-Data` |
| 请求体 | 标准 OpenAI 字段 | `prepareCompatibleModelRequest` 只改写模型名与推理字段，没有私有顶层字段 |
| 重试 | SDK 层关掉自动重试（`maxRetries: 0`），业务层自己判 429/502/503 并切备用域名 | `isRequestLevelRetryableError`、`applyChatFailoverOrigin` |
| 首 token 超时 | 默认 20 分钟 | `resolveRequestTimeoutMs` 返回 `12e5`（可被 `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS` 覆盖） |

### 3.2 模型清单

`GET {端点}/v3/config`，请求头带 `__codebuddyProductConfigurationRequest: true`（常量 `PRODUCT_CONFIGURATION_REQUEST_KEY`）。返回的 `models` 数组里每项含 `id`、`name`、`descriptionZh/En`、`credits`（积分倍率）、`maxInputTokens`、`maxOutputTokens`、`reasoning`（档位与默认档）、`supportsToolCall`、`supportsImages`、`tags`、`temperature`。

本机缓存的一份（`~/.workbuddy/local_storage` 里服务端下发的产品配置，61 个模型）里包含：`auto`（自动选模）、`fast-model`（快速）、`balanced-model`（均衡）、`deep-model`（极致）、`hy3` 系列、`glm-5.3`/`glm-5.3-flash`/`glm-5.2`、`deepseek-v4-pro`/`deepseek-v4.1-flash`、`kimi-k3.1-pro`、`minimax-m3.1-flash`、`step-5-preview`、`mimo-v2.6-pro` 等。

**实测**：不带鉴权请求 `/v3/config` 返回 200，但 `models` 为 `null`——清单要登录后才拿得到。

### 3.3 登录与续期

来自 CLI 里的 `AccountScopedExternalLinkAuthenticationProvider`（端点取 `configuration.authentication?.endpoint || configuration.endpoint`，前缀取 `authentication.attributes.prefixPath`，WorkBuddy 为 `/plugin`）：

1. `POST {端点}/v2{prefixPath}/auth/state?platform={platform}`，请求头带 `X-No-Authorization`/`X-No-User-Id`/`X-No-Enterprise-Id`/`X-No-Department-Info` 各为 `true`，以及 `X-Domain`（端点主机名）→ 响应 `data.data` 里是 `{state, authUrl}`。
2. 打开 `authUrl` 让用户在浏览器里完成腾讯云账号授权。
3. 轮询 `GET {端点}/v2{prefixPath}/auth/token?state={state}`（同样带 No-* 头）→ 拿到 `accessToken`、`refreshToken`、`expiresIn`、`refreshExpiresIn`。没登好时返回业务码表示「pending」。
4. `GET {端点}/v2{prefixPath}/account`，带 `Authorization: Bearer <accessToken>` → 账户信息（`uid`、`nickname`、`enterpriseId`）。
5. 续期 `POST {端点}/v2{prefixPath}/auth/token/refresh`，请求头 `X-Refresh-Token: <refreshToken>`、`X-Auth-Refresh-Source: plugin` → 新的令牌。

**本机实测（2026-11-05）**：

- `POST https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy` → `{"code":0,...,"data":{"state":"…","authUrl":"https://www.workbuddy.cn/login?platform=workbuddy&state=…"}}`。
- 同样打到 `https://copilot.tencent.com` 也通（两个站点的登录页都存在）。
- 轮询 `GET /v2/plugin/auth/token?state=…` 未登录时返回 `{"code":11217,"msg":"login ing..."}`——pending 码就是 **11217**。

## 四、架构

新增目录 `src/workbuddy/`，职责单一、互不依赖：

| 文件 | 职责 |
|---|---|
| `endpoints.ts` | 端点常量与解析：默认端点、`/v2/plugin/*` 四个登录接口、`/v2/chat/completions`、`/v3/config`；允许用环境变量与 preset 配置覆盖 |
| `auth.ts` | 登录会话：`startLogin`（要 state + 登录网址）、`pollToken`（轮询取令牌）、`fetchAccount`、`refreshSession` |
| `credential.ts` | 凭据的存放与读取：内存缓存 + 本机文件；判断是否需要登录/需要续期；出错时把令牌从消息里抹掉 |
| `models.ts` | 模型清单：登录后拉 `/v3/config`，解析成 `{id, name, description, contextWindow, efforts}`；缓存与失败降级 |
| `openai.ts` | 请求体构造：DSH 消息 → OpenAI chat messages；工具 → function schema；推理档位映射 |
| `sse.ts` | SSE 解析：OpenAI 增量 → 本仓库统一的块词汇（text / reasoning / tool-call / usage / finish） |
| `chat.ts` | 一次模型请求：拼头、发请求、读流、错误分类与重试 |

外加 `src/workbuddy-model.ts`——模型插件入口，形状与 `src/zcode-model.ts` 一致：认下 `agent === 'workbuddy'` 的 preset，把 `CatalogTurnRequest` 翻译成 `src/workbuddy/` 的调用。

宿主路由（新增一行挂载）：

- `GET /acp-agent/workbuddy/session` → 登录状态（`authenticated`、`account`、是否需要重新登录）。
- `POST /acp-agent/workbuddy/login` → 开始一次登录，返回 `{url}`（授权地址）与过期时间。

## 五、凭据设计

### 5.1 流程

```
用户点「去授权」
  → POST /acp-agent/workbuddy/login
  → 宿主向 {端点}/v2/plugin/auth/state 要 state 与 authUrl
  → 宿主返回 {url}；浏览器打开该地址
  → 用户在腾讯云页面完成授权
  → 宿主轮询 {端点}/v2/plugin/auth/token?state=…
      pending(11217) → 继续等
      拿到令牌 → 拉一次 /v2/plugin/account 补齐 uid/企业 id → 存下
```

轮询在宿主进程里进行，不占浏览器。单次登录的轮询上限 5 分钟，超时即放弃并保留「需要登录」状态（用户可以再点一次「去授权」重新开始）。

### 5.2 存放

- 内存：宿主进程内缓存一份，`{accessToken, refreshToken, expiresAt, account}`。
- 落盘：`{DSH_HOME 或 ~/.dsh}/workbuddy/credentials.json`，权限 `0600`，只存令牌与账户 id，不存密码。
- 令牌**不出现**在任何日志、错误消息、宿主路由应答里（沿用 `zcode` 的 `scrub` 做法）。

### 5.3 续期

- 请求前若访问令牌剩余有效期不足 60 秒 → 先续期再发。
- 收到 401/403 → 续期一次并重试该次请求一次；再失败则本回合以「需要重新登录」结束。
- 刷新令牌也过期 → 状态转成「需要登录」，浏览器侧提示去授权。

### 5.4 端点

默认端点 `{端点} = https://www.workbuddy.cn`（官方外网站，登录页与模型端点同源）。

- 登录接口与模型接口**必须同源**：登录在哪个站，模型就在哪个站。
- 覆盖方式（按优先级）：preset 配置 → 环境变量 `WORKBUDDY_BASE_URL` → 默认值。
- 企业内网/其它站点由配置指定；`copilot.tencent.com` 实测登录接口同样通。

## 六、模型请求设计

### 6.1 请求

- 方法与地址：`POST {端点}/v2/chat/completions`。
- 请求头：
  - `Authorization: Bearer <accessToken>`
  - `Content-Type: application/json`，`Accept: text/event-stream`
  - `X-User-Id: <uid>`；有企业 id 才带 `X-Enterprise-Id`
  - `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Request-ID`：DSH 会话与消息 id
  - `X-Agent-Intent`：默认 `craft`（WorkBuddy 的交互模式名；我们只用它的模型，不需要它的模式语义，但服务端会记这个头）
  - `X-Product`：可选，默认留空——真机抓包核对服务端是否在意这个头后再定值
  - 可选 `traceparent`：DSH 侧没有现成的 trace 上下文就不带，不为此引入依赖。
- 请求体：
  - `model`：preset 行里选中的模型 id。
  - `messages`：DSH 消息投影成 OpenAI chat 消息（见 6.2）。
  - `stream: true`
  - `tools`：DSH 工具投影成 OpenAI function schema（`type: "function"`，`function.name/description/parameters`）。
  - `max_tokens`：调用方给就用，否则按模型配置的 `maxOutputTokens`，再否则 32000。
  - `reasoning_effort`：DSH 的推理档位按模型清单里的 `reasoning.supportedEfforts` 校验后下发；模型不支持就省略。
  - `temperature`：模型清单给了才带。

### 6.2 消息投影

DSH 的消息（见 `src/zcode/anthropic.ts` 的 `projectMessages`，那是 anthropic 形状的版本）→ OpenAI：

| DSH | OpenAI |
|---|---|
| `role: system/developer` | `role: system` 的独立消息（合并到开头一条） |
| `role: user`，文本块 | `role: user`，`content` 为文本（相邻同角色合并） |
| `role: user`，图片块 | `content` 数组里的 `image_url` 部分（模型 `supportsImages` 为真才带，否则退化成占位文本） |
| `role: assistant`，文本块 | `role: assistant`，`content` 文本 |
| `role: assistant`，`tool-call` 块 | `tool_calls: [{id, type: "function", function: {name, arguments}}]` |
| `role: assistant`，`reasoning` 块 | **不重放**（OpenAI 侧不需要推理签名；WorkBuddy 的推理字段随轮次自带） |
| `role: tool` | `role: tool`，`tool_call_id` + `content` |

工具调用与工具结果必须成对（`src/tool-pairing.ts` 已有配对逻辑，模型插件入口复用它）。

### 6.3 响应

SSE 逐行解析 `data:` 帧（`[DONE]` 结束）：

- `choices[0].delta.content` → 文本增量
- `choices[0].delta.reasoning_content`（部分模型叫 `reasoning`）→ 推理增量
- `choices[0].delta.tool_calls[]` → 工具调用增量：首帧带 id 与名字，后续帧只带参数片段（按 index 归并）
- `choices[0].finish_reason` → `stop` / `tool_calls` / `length`
- `usage` → token 用量

解析结果落到本仓库统一的块词汇（与 `zcode`/`minimaxi` 同一套 `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`），宿主循环照旧拼装。

### 6.4 错误处理

| 情况 | 处理 |
|---|---|
| 401 / 403 | 续期一次并重试一次；仍失败 → 回合以「需要重新登录」结束 |
| 429 | 照实报出业务错误码与消息，不自动重试（额度类错误重试无意义） |
| 5xx | 有限重试（2 次，指数退避），仍失败 → 回合报错 |
| 网络中断 / 连接被拒 | 报「传输失败」，让宿主自己重试这一轮（与 `zcode` 的 `TRANSPORT` 失败码同义） |
| 响应不是 SSE / 解析失败 | 回合报错，消息里带状态码与前 500 字响应体（抹掉令牌） |

## 七、模型清单

- 登录成功后拉 `GET {端点}/v3/config`（带 `__codebuddyProductConfigurationRequest: true`），解析 `models` 数组：
  - `id`、`name`、`description`（取 `descriptionZh`，没有就取 `descriptionEn`）
  - `contextWindow` = `maxInputTokens`
  - 推理档位 = `reasoning.supportedEfforts`（没有就按 `reasoning.defaultEffort` 单一档）
  - `supportsToolCall` / `supportsImages`
- **选择器以运行时清单为准**（与其它行「agent 自报为准」的规矩一致）；拉不到（未登录或网络失败）时退回 preset 行里声明的兜底清单，并在界面标明「未登录，显示的是静态清单」。
- 清单按账号缓存（同一账号下模型一样），刷新时机：登录成功、显式刷新、距离上次超过 24 小时。

## 八、与本仓库的接线

逐处改动点：

1. `src/workbuddy/*`、`src/workbuddy-model.ts`——新增（第四节）。
2. `src/model-plugins.ts`——把 WorkBuddy 加进插件列表，并把 `'workbuddy'` 加进 `MODEL_BACKED_AGENTS`（这个集合决定「哪些行由模型插件应答」，列漏了会出现「行挂上了但发消息走了网关」）。
3. `src/factory.ts`——两处「这行不是 ACP 会话」的守卫各加一条 `workbuddy`（现有 `zcode`/`minimaxi` 各有一处）。
4. `src/catalog.ts`——显示名表加 `workbuddy: 'WorkBuddy'`。
5. `cordis.patch.yml`——新增一行 preset（`id: acp-workbuddy`、`name: WorkBuddy`、`order` 排在现有行之后），绑定 `agent: workbuddy`；这一行声明两样东西：
   - `efforts`：推理档位轴。取运行时清单里各模型 `reasoning.supportedEfforts` 的并集；未登录时退回这里声明的静态档位（按 WorkBuddy 模型实际接受的档位列，不自造）。
   - `models`：兜底清单（未登录或拉不到 `/v3/config` 时选择器显示的内容）。
   另加一条宿主路由行（`workbuddy-login`）承载第五节的登录/状态路由。
6. `src/client/`——模型选择器里给未登录的 WorkBuddy 挂一枚「去授权」提示（复用 `src/client/quota-login.ts` 的画法与 `quota-pill.ts` 的登录入口接线）。
7. `src/health.ts`——自报门面里把 WorkBuddy 这一行报出来（哪几行挂上了、哪几行缺）。
8. `docs/agent-acp/workbuddy.md`——按现有几篇的体例写：怎么接上去、哪里会出错、字段对照。
9. `docs/agent-acp/README.md`——把 WorkBuddy 加进对照表（标注「模型插件，不走 ACP」）。

## 九、浏览器侧

- 模型选择器里选到 WorkBuddy 的模型而宿主报「未登录」时，输入框下方或模型行旁出现一枚「去授权 WorkBuddy」，点了开授权地址。
- 授权完成后自动回到可用的模型清单，界面刷新一次。
- 令牌与授权状态只在宿主侧，浏览器拿到的只有状态与地址。

## 十、测试策略与门禁

**单元测试（vitest）**

- `sse.ts`：用真机抓的一段 WorkBuddy SSE 响应做夹具，钉住文本/推理/工具调用/用量/结束原因；再钉住畸形帧（缺字段、多余字段、空行）不炸。
- `openai.ts`：钉住消息投影的每一种 DSH 输入 → OpenAI 输出；工具 schema 形状；推理档位映射；图片降级。
- `auth.ts`：假 fetch 依次返回 state → pending → 令牌，钉住轮询次数与超时；刷新成功/失败两条路。
- `credential.ts`：钉住「快过期先续期」「401 续期后重试一次」「刷新失效转需要登录」；令牌不出现在错误消息里。
- `models.ts`：钉住 `/v3/config` 解析与降级。

**门禁**：`pnpm typecheck`、`pnpm test`、`pnpm build` 全绿；改动浏览器半边后 `pnpm build:client` 重建 `lib/client.js`。

**真机验收**：用真实 WorkBuddy 账号跑一次完整回合（发消息 → 工具调用 → 执行 → 收尾），抓一次请求与响应存档为夹具。

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 协议是「OpenAI 兼容」而非「保证就是 OpenAI」，可能带腾讯私有扩展 | 请求体或响应解析对不上 | 第一步就真机抓包，按实际字段写实现；夹具来自真机，不来自 OpenAI 文档 |
| 登录页需要腾讯云账号，本机不一定有可用账号 | 联调卡住 | 登录与模型请求分层：登录用假 fetch 测，模型请求用真机抓的夹具测；端点与账号可配置 |
| 端点归属搞错（登录站 ≠ 模型站） | 401 / 404 | 登录与模型强制同源；端点一处配置，两处引用 |
| 上游改协议或改路径 | 整行失效 | 协议细节集中在一个模块里；文档写明「核对时间」；失败时错误消息直接说哪个接口失败 |
| 令牌泄漏 | 账号被盗 | 令牌只进内存与 0600 文件；所有对外消息过一遍抹除；路由应答不含令牌 |
| 计费：走 WorkBuddy 账号积分 | 用户不知情就扣分 | 模型清单里带倍率描述，界面显示；文档写明计费口径 |

## 十二、未决问题

- 「端点」在正式版该指向官方外网站还是企业内网站——按部署方配置，不设默认偏向。
- WorkBuddy 的积分余额接口尚未定位（v1 不做配额胶囊，先不查）。
- 模型清单里 `auto` 这类「自动选模」条目在 DSH 选择器里的呈现方式（一个条目 vs 展开成多个）——v1 当普通条目处理。

## 十三、交付顺序

1. 协议层：`endpoints.ts` / `openai.ts` / `sse.ts` / `chat.ts` + 夹具与单测。
2. 凭据层：`auth.ts` / `credential.ts` + 单测。
3. 清单层：`models.ts` + 单测。
4. 接线：模型插件入口、`model-plugins.ts`、`factory.ts`、`catalog.ts`、`cordis.patch.yml`、`health.ts`。
5. 浏览器侧：授权入口 + 重建 `lib/client.js`。
6. 文档：`docs/agent-acp/workbuddy.md` 与对照表更新。
7. 真机验收与抓包存档。
