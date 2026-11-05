# Qoder 国际版模型行的设计

> 核对时间：2026-11-05
> 证据来源：本机 `/Applications/Qoder.app`（0.5.3，com.qoder.app）内置的
> `@qoder-ai/qoder-agent-sdk` worker（`dist/_worker/qoder-worker-runtime.obf.mjs`，34 MB 单行混淆），
> 以及本机 `~/.qoder/logs/runs/…/qodercli.log` 里真实发生的请求。

## 一句话结论

Qoder 国际版**没有随桌面版安装 CLI**（本机只有 CN 版的 `qoderclicn`），它的能力只存在于
桌面 App 内置的 worker 里。因此接入方式不是「再起一个 ACP 进程」，而是**把它的模型接口
接成 DSH 的一行模型**：插件自己登录、自己发模型请求，工具仍由 DSH 执行。

这与仓库里已有的 CN 版 `acp-qoder` 行并存、互不干扰：CN 走官方 ACP 协议，国际版走直连模型接口。

## 逆向得到的事实

worker 是单行混淆的 34 MB 文件，普通 grep 定位不到关键处。做法是两条：

1. **解混淆**：worker 里的字符串用 `_$d1("…")` 包着，是 base64 之后按固定 12 字节密钥
   `2nipF7Qi2SoZ` 逐字节 XOR。把这层解开（全文件 17324 处），文件才变得可 grep。
2. **按字符串抽上下文**：解混淆后仍是一行超长文件，用一个只按字面串取前后上下文的
   小脚本定位（`grep` 的 `{n,m}` 上限 255，单行文件用不了）。

### 端点（国际版 prod）

| 用途 | 地址 | 出处 |
|---|---|---|
| 浏览器授权页 | `https://qoder.com/device/selectAccounts` | `Uq="https://"+(js?"qoder.cn":"qoder.com")` |
| 设备令牌轮询/续期 | `https://openapi.qoder.sh/api/v1/deviceToken/{poll,refresh}` | `S9` |
| 账号信息 | `https://center.qoder.sh/api/v1/userinfo` | `w9` |
| 模型清单 | `https://api3.qoder.sh/api/v2/model/list?Encode=1` | `vq` |
| 模型请求 | `https://api2-v2.qoder.sh/model/v1/chat/completions` | `JYA`（`Mot()` 拼 `/model/v1/chat/completions`） |

同一组常量里还有 CN 与 daily/test 的对应值——说明这一组是**按品牌与环境成套的**，
不是一个统一的站点。因此「端点同源」在这里的准确含义是：**登录签发的令牌与模型请求必须
来自同一套环境**，不是「同一个域名」。

### 登录（设备码 + PKCE）

- 授权页参数：`challenge`（SHA-256(verifier)）、`challenge_method=S256`、`nonce`（UUID）、
  `machine_id`、`client_id`；prod 的 client_id 是 `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`。
- 轮询：`GET {openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`。
  **HTTP 404 表示「用户还没在浏览器里授权」，是正常等待态，不是错误**；其它非 2xx 才是失败。
- 轮询成功：应答是**顶层** `{token, refresh_token, expires_at | expires_in,
  refresh_token_expires_at | refresh_token_expires_in, user_id, user_name}`，**没有 `data` 外壳**。
- 续期：`POST {openapi}/api/v1/deviceToken/refresh`，体 `{refresh_token, machine_id}`，
  应答 `{device_token, refresh_token, expires_at, refresh_token_expires_at}`。
- 轮询拿到的 `token` 同时被当作 `security_oauth_token` 与 `access_token`，
  直接作模型请求的 Bearer——**中间没有换票这一步**。

### 模型清单

`GET {api3}/api/v2/model/list?Encode=1`（带 Bearer 与 `Cosy-*` 身份头）。
应答是**按场景分组的对象**：`{"assistant": [ … ], … }`，取 `assistant` 那组。
每条模型有 `key`（模型 id，请求体里就发它）、`display_name`、`is_reasoning`、`efforts`、
`default_effort`、`max_input_tokens`、`is_vl`、`provider`、`format`。

### 模型请求

`POST {api2-v2}/model/v1/chat/completions`，SSE：

- 头：`Authorization: Bearer <token>`、`Accept: text/event-stream`、
  `Content-Type: application/json`、`X-Request-ID`、`X-Session-ID`、
  以及身份头 `Cosy-Version`（`1.1.79-hotfix.11`）、`Cosy-ClientType`（`5`）、
  `Cosy-MachineOS`（`aarch64_darwin`）、`Cosy-MachineHostname`（仅推理请求）。
- 体：OpenAI 形状（`model`、`messages`、`stream: true`、`stream_options: {include_usage: true}`、
  `tools`、`reasoning_effort`…）**外加** `metadata.context`：
  `{request_id, request_set_id, session_id, source_session_id?, task_id?, client_type}`。

## 设计

### 行的形态

新增 agent id `qoder-global`，作为**模型行**（`MODEL_BACKED_AGENTS` 的一员）：

- 预置行 id：`acp-qoder-global`，显示名「Qoder 国际版」。
- 工具由 DSH 执行（与 WorkBuddy / MiniMax 同一形态），Qoder 只负责「回答模型那一问」。

### 端点

`src/qoder/endpoints.ts` 给出**一组**地址，默认就是上表里的国际版 prod 常量；
每个地址各有一个环境变量可覆盖（`QODER_OPENAPI_BASE` / `QODER_CATALOG_BASE` /
`QODER_MODEL_BASE` / `QODER_LOGIN_BASE`）。默认四个地址来自同一套环境——
这才是这里的「同源」不变量，测试把它钉住。

### 凭据

独立存放于 `~/.dsh/qoder-global/credentials.json`（文件 0600、目录 0700，
**目录已存在时也要收紧权限**）。**不读、不写 Qoder 桌面版自己的凭据**——
那是它的加密存储，插件不该碰。

跨进程用文件锁串行化续期：第二个进程发现令牌已被第一个换掉时直接采用新令牌，
不重复续期。

### 模型清单

登录后拉一次清单写进运行时账本（选择器以它为准），成功后 24 小时内不重拉，
失败后 5 分钟内不重试（不然每一轮都去撞上游）。预置行里留一份兜底清单，
拉不到时选择器不至于整组消失。

### 模型请求

一次模型请求 = 一次 SSE。失败分三类：

- HTTP 401 → 续期一次再重试，仍失败就以「需要重新登录」结束；
- SSE 出现错误帧 → 直接报错，**错误信息里不许反射令牌**；
- SSE 断流（没有结束帧） → 报错，**不能当成一次成功的空回答**。

### 登录与设置页

宿主侧挂两条路由（浏览器只拿得到地址与「登了没」，拿不到凭据）：

- `GET /acp-agent/qoder-global/session`：登录状态、账号、是否在等待授权；
- `POST /acp-agent/qoder-global/login`：启动一次设备码流程，返回授权地址。

设置页加一节「Qoder 国际版账号」，与 WorkBuddy 那一节并列。

## 不做什么

- 不改 CN 版 `acp-qoder` 行的任何行为；
- 不读 Qoder 桌面版的凭据或缓存；
- 不装国际版 CLI（本机没有，且直连模型接口已足够）；
- 不做配额/用量面板（国际版的用量口径尚未实测）。

## 验收

- 单元测试：端点常量、PKCE 生成、404 当等待、续期字段、清单解析（按场景分组）、
  请求体与头、SSE 错误与断流、凭据目录权限、路由不泄露密钥。
- 门禁：`tsc --noEmit`、`vitest run`（全量）、客户端构建。
- 真机验收（需要人在浏览器点一次授权）：登录 → 拉到清单 → 选一个模型 → 跑通一个回合。
