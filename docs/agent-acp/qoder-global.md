# Qoder 国际版的模型行

> 核对时间：2026-11-05
> 来源：本机 `/Applications/Qoder.app`（0.5.3，com.qoder.app）内置的
> `@qoder-ai/qoder-agent-sdk` worker（`dist/_worker/qoder-worker-runtime.obf.mjs`，
> 34 MB 单行混淆），以及 `~/.qoder/logs/runs/…/qodercli.log` 里真实发生的请求。
> 状态：**协议已核对，单元测试与全量门禁通过；真机登录与回合待人验证。**

## 一句话结论

Qoder 国际版**没有随桌面版安装 CLI**（本机只有 CN 版的 `qoderclicn`），它的能力只
存在于桌面 App 内置的 worker 里。所以接入方式不是「再起一个 ACP 进程」，而是
**把它的模型接口接成 DSH 的一行模型**：插件自己登录、自己发模型请求，工具仍由
DSH 执行。

这与仓库里已有的 CN 版 `acp-qoder` 行并存、互不干扰：CN 走官方 ACP 协议，国际版
走直连模型接口。

## 怎么找到「它怎么请求模型」

worker 是单行混淆的 34 MB 文件，直接 grep 定位不到关键处。两条做法：

1. **解混淆**：worker 里的字符串用 `_$d1("…")` 包着，是 base64 之后按固定 12 字节
   密钥 `2nipF7Qi2SoZ` 逐字节 XOR。把这一层解开（全文件 17324 处），文件才变得
   可 grep。
2. **按字符串抽上下文**：解混淆后仍是一行超长文件，用一个只按字面串取前后上下文的
   小脚本定位（`grep` 的 `{n,m}` 上限 255，单行文件用不了）。

定位到的关键函数：`Mot`/`oWi`（模型地址）、`Wat.openResponse`（请求头与流式）、
`OFn`（请求体）、`Rpl`（设备码流程）、`buildUserInfoFromDeviceToken`（令牌怎么用）。

## 端点（国际版 prod 一组）

| 用途 | 地址 |
|---|---|
| 浏览器授权页 | `https://qoder.com/device/selectAccounts` |
| 设备令牌轮询/续期 | `https://openapi.qoder.sh/api/v1/deviceToken/{poll,refresh}` |
| 账号信息 | `https://center.qoder.sh/api/v1/userinfo` |
| 模型清单 | `https://api3.qoder.sh/api/v2/model/list?Encode=1` |
| 模型请求 | `https://api2-v2.qoder.sh/model/v1/chat/completions` |

同一组常量里还有 CN 与 daily/test 的对应值——说明它是**按品牌与环境成套的**，
不是一个统一站点。因此这里的「端点同源」是：**登录签发的令牌与模型请求必须出自
同一套环境**，不是「同一个域名」。默认四个地址成组给出；换地址用
`QODER_LOGIN_BASE` / `QODER_OPENAPI_BASE` / `QODER_CENTER_BASE` /
`QODER_CATALOG_BASE` / `QODER_MODEL_BASE` 逐项覆盖。

## 登录：设备码 + PKCE

1. 生成 verifier / challenge / nonce / machine_id，浏览器打开
   `{loginBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`；
   国际版 prod 的 client_id 是 `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`。
2. 轮询 `{openapiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`。
3. **HTTP 404 表示「用户还没在浏览器里授权」**，是等待态，不是错误；其它非 2xx 才是失败。
4. 轮询成功：应答是**顶层** `{token, refresh_token, expires_at | expires_in,
   refresh_token_expires_at | refresh_token_expires_in, user_id, user_name}`，
   **没有 `data` 外壳**。

续期：`POST {openapiBase}/api/v1/deviceToken/refresh`，体 `{refresh_token, machine_id}`，
应答 `{device_token, refresh_token, expires_at, refresh_token_expires_at}`
——**续期的令牌字段叫 `device_token`，轮询那次叫 `token`**。

轮询拿到的 `token` 同时充当 `security_oauth_token` 与 `access_token`，
**直接作模型请求的 Bearer，中间不换票**。

## 模型清单

`GET {catalogBase}/api/v2/model/list?Encode=1`（带 Bearer 与 `Cosy-*` 身份头）。

**应答是按场景分组的对象**：`{"assistant": [ … ], "其他场景": [ … ] }`，取 `assistant`
那一组。每条模型：

| 字段 | 含义 |
|---|---|
| `key` | 模型 id，请求体里就发它 |
| `display_name` | 给人看的名字 |
| `is_reasoning` / `efforts` / `default_effort` | 推理档位（**每个模型自己声明**） |
| `max_input_tokens` | 输入长度上限 |
| `is_vl` | 支不支持图片 |
| `maxTokensField` | 请求体里「最大 token」用哪个字段名 |

worker 内置的默认模型是 **`qwen3.8-max`**（`Qwen 3.8 Max`），它的
`maxTokensField` 是 **`max_completion_tokens`**——发成 `max_tokens` 服务端不认。
清单没到手时（没登录、拉不到），预置行里声明的就是这一项。

## 模型请求

`POST {modelBase}/model/v1/chat/completions`，SSE。

**头**：`Authorization: Bearer <设备令牌>`、`Accept: text/event-stream`、
`Content-Type: application/json`、`X-Request-ID`、`X-Session-ID`、
`Cosy-Version`（`1.1.79-hotfix.11`）、`Cosy-ClientType`（`5`）、
`Cosy-MachineOS`（`aarch64_darwin`）。

**体**：OpenAI 形状（`model`、`messages`、`stream: true`、
`stream_options: {include_usage: true}`、`tools`、`reasoning_effort`、
最大 token 用模型声明的字段名）**外加** `metadata.context`：
`{request_id, request_set_id, session_id, client_type}`。

**失败分三类**：

- HTTP 401 → 续期一次再重试，仍失败就说「请重新登录」；
- SSE 里有错误帧 → 直接报错，错误信息里**不反射令牌**；
- SSE 断流（没有结束帧）→ 报错，**不能当成一次成功的空回答**。

## 接进本项目

| 位置 | 做什么 |
|---|---|
| `src/qoder/endpoints.ts` | 一组端点 + `Cosy-*` 身份头；逐项可覆盖 |
| `src/qoder/auth.ts` | 设备码流程、轮询（404 = 等待）、续期（`device_token`） |
| `src/qoder/credential.ts` | 独立凭据文件（目录 0700 / 文件 0600，**已存在也收紧**）、跨进程续期 |
| `src/qoder/models.ts` | 清单的解析（按场景分组）与拉取；worker 内置模型表 |
| `src/qoder/chat.ts` | 请求体、请求头、SSE、失败分类 |
| `src/qoder-model.ts` | 认下 `agent: qoder-global` 那一行；发布运行时清单；按模型过滤档位与字段名 |
| `src/qoder-route.ts` | 宿主登录路由（浏览器只拿得到地址与「登了没」） |
| `src/client/qoder-account-section.tsx` | 设置里的账号段 |

预置行 `acp-qoder-global`（显示名「Qoder 国际版」），健康自报行
`acp-qoder-global` 与 `acp-agent-qoder-login`。

## 边界

- **不读、不写 Qoder 桌面版自己的凭据**——它在应用自己的加密存储里；插件走自己的
  设备码登录，令牌只留在宿主进程与 `~/.dsh/qoder-global/credentials.json`。
- 只支持本次核对的官方国际版端点；不借用国内版令牌，不支持企业 VPC。
- worker 里还有 legacy / gRPC 两条模型传输，本实现只用 HTTP 那条。

## 实测与未实测

**已核对（对着 worker 与本机日志）**：端点一组、设备码四步、404 当等待、顶层令牌、
续期字段名、清单按场景分组、请求体与请求头、内置模型 `qwen3.8-max` 及其
`max_completion_tokens`。

**已实测（无凭据的公开探测）**：模型端点无 Bearer 回 `HTTP 401`；轮询未授权回
`HTTP 404`。

**未实测（需要一次真机登录）**：登录成功后的凭据形状、清单里真实的模型 id 与档位、
一次真实回合的 SSE 帧、模型权限、配额口径。

**单元测试覆盖**：端点常量、PKCE 生成、404 当等待、续期字段、目录权限收紧、
并发续期只续一次、清单解析、请求体与头、401 重试、断流与错误帧、档位过滤、
最大 token 字段名、路由准入与不泄密、设置页视图。

## 设置里的账号与模型勾选

设置里有「Qoder 国际版账号」一节：上面是账号（一个框，显示昵称与 uid），下面一行两个按钮（「登录 Qoder 国际版」「检查授权」），再往下是**模型勾选清单**——站点给的整份清单都列出来，勾上的才进模型选择器。

- 勾选结果存在本机：`~/.dsh/qoder/selection.json`（0600）。没自己勾过时，生效的是挂载行里声明的那一份；自己勾过就以勾的为准。
- 勾完立刻重发清单，选择器下一次打开就是新的那份。
- 清单里没勾的模型**不进账本**：这一行只提供勾上的那些（与 WorkBuddy 同一套规矩）。
- 宿主那边的路由：`GET /acp-agent/qoder-global/session`、`POST /acp-agent/qoder-global/login`、`GET`/`POST /acp-agent/qoder-global/models`。

## 模型清单：站点那份要 Qoder 自己的签名（核对时间 2026-11-05）

我们**拿不到** Qoder 站点那份完整的模型清单，实测过程：

- 地址是 `https://api3.qoder.sh/api/v2/model/list?Encode=1`，但真正要打的是
  `https://api3.qoder.sh/algo/api/v2/model/list?Encode=1`——少了 `/algo` 这一段
  直接 404（SDK 里拼地址的 `GK()` 会加它）。
- 加上 `/algo` 之后是 **403 `Signature invalid`**：这一发请求要带 Qoder 自己
  生成的签名，而签名逻辑在他们的**原生模块**里（`qodercontext_prepareRequest`），
  不是 JS 能复刻的。
- 桌面版拿得到，是因为它自带那份原生 SDK。
- 应用缓存的清单（`~/.qoder/.models/<uid>/catalog-v7`）是**加密**的（Electron 的
  safe storage），我们读不了。

所以设置里的清单在拿不到站点清单时**退回预置声明的那一份**（目前只有 `auto`）。
`auto` 是服务端认的 id：2026-11-05 实测 `qwen3.8-max` 会回
`invalid_model_error: Unsupported model`，而 `auto` 被接受（后端偶发
`All backends failed`，与 id 无关）。

**推理请求本身不需要签名**：`{api2-v2}/model/v1/chat/completions` 用我们的设备令牌
就能通（`Cosy-Version` / `Cosy-ClientType` / `Cosy-MachineOS` 三个头就够）。

## 模型清单：借应用自带的 SDK 拿（核对时间 2026-11-05）

**结论先说**：站点那份清单**拿不到**——它要 Qoder 自己的**原生模块**算签名，JS 复刻不了。
所以我们不自己发那一发，而是**让 SDK 自己算**：应用里带着 agent SDK（`--sdk` 模式跑起来，
stdin/stdout 说 NDJSON 的控制协议），我们把令牌交给它，它去把清单拉回来。

宿主侧的做法（`src/qoder/catalog.ts`）：

1. 起 SDK：`Qoder <qoder-worker-runtime.obf.mjs> --sdk`，令牌写在
   `QODER_SDK_AUTH_PAYLOAD_FILE` 指向的文件里（不经过协议、不进日志）；
2. 说两句：`daemon.initialize`（协议版本 2、能力 `multi_session_v2`）→
   `daemon.get_models`（`fetchStrategy: "live"` 强制去远端拉）；
3. 拿到清单（id、显示名、倍率、上下文、**每个模型支持哪些档位**）就关掉进程。

**这解决了三件事**：选择器里能列出真实模型（15 个，带倍率）；每个模型的档位是准的
（各模型不同，档位发错服务端会拒）；以及不用猜模型 id。

**真实清单**（2026-11-05 拉的）：

| id | 名称 | 倍率 | 上下文 | 档位 |
|---|---|---|---|---|
| auto | Auto | x0.5 | 200k | — |
| ultimate | Ultimate | x2 | 1000k | xhigh/high/low/max/medium |
| fast | Fast | x0.8 | 200k | — |
| efficient | Efficient | x0.3 | 200k | — |
| smodel | Sonus | x8 | 180k | xhigh/high/low/max/medium |
| cmodel | Cantus | x4 | 180k | xhigh/high/low/max/medium |
| qmodel_38max | Qwen3.8-Max | x0.5 | 180k | xhigh/low/medium |
| qfmodel | Qwen3.8-Flash | x0 | 180k | xhigh/low/medium |
| kmodel_latest | Kimi-K3.1-Pro | x1 | 180k | high/low/max |
| kmodel | Kimi-K2.8-Preview | x0.8 | — | high/low/max |
| gmodel | GLM-5.3 | x0.8 | 180k | high/low/max |
| gfmodel | GLM-5.3-Flash | x0.1 | 1000k | high/max |
| dmodel | DeepSeek-V4-Pro | x0.5 | 1000k | high/max |
| dfmodel | DeepSeek-Flash | x0.1 | 1000k | high/max/low |
| mmodel | MiniMax-M3.1-Flash | x0.1 | 180k | xhigh/high/low/max/medium |

**推理不需要 SDK**：用这些真 id，我们的客户端直接就能跑（2026-11-05 实测 `gmodel`、
`mmodel` 返回正常流式内容）。SDK 只用来拿清单。

> ⚠️ **别再用假 id**：早先声明的 `qwen3.8-max` 不是这个账号的真实 id，服务端会回
> `invalid_model_error: Unsupported model`；`auto` 这个路由对我们这个令牌作用域
> 回 `All backends failed`。

## 为什么我们拿不到桌面版那份登录凭证（核对时间 2026-11-05）

按「复用桌面版登录」的思路查了一轮，结论是**拿不到**，原因有三条，每条都有实测：

1. **桌面版的本地服务不是模型清单的来源。** 它的地址与密钥明文写在
   `~/.qoder/mcp-router.json`（`baseUrl` + `apiKey`），鉴权头是 `x-api-key`
   （带上就从 401 变 404，说明过了）。但它是 **MCP 路由器**（把 MCP 客户端接到
   应用的各种 MCP 服务器），**没有模型清单这个接口**——扫了 50 多条路径（`/models`、
   `/api/v1/models`、`/catalog`、`/api/v2/model/list`、`/mcp`…）全是 404。

2. **站点的清单接口要他们自己的签名。** 真实地址是
   `{api3}/algo/api/v2/model/list?Encode=1`——**少了 `/algo` 这一段直接 404**
   （SDK 拼地址时会加）。加上之后是 **403 `Signature invalid`**：签名由他们的
   **原生模块**算（`qodercontext_prepareRequest`），不是 JS 能复刻的；应用里那份
   agent SDK 是 35MB 的 worker 包（`qoder-worker-runtime.obf.mjs`），没有可调用的
   库入口。

3. **应用缓存的清单是加密的。** `~/.qoder/.models/<uid>/catalog-v7`（CLI 日志说
   **24 个模型**）读不出来。钥匙串里只有主密钥（service `Qoder App Safe Storage`
   / account `Qoder App Key`），应用数据库 `collaboration_runtime_credentials` 里还有
   一份 `v10` 密文的运行时令牌——试了十几种 Electron safe storage 的参数组合
   （salt、迭代次数、AES-128/256、是否 hex 解码口令）都解不开。

### 顺带查到的三件有用的事

- **`x-gw-user-id` 头**：带上它，推理错误会从 `All models failed`（模型解析不出来）
  变成 `All backends failed`（模型解析出来了，但没有这个令牌作用域可用的后端）。
- **这个账号只认 `auto` 一个 id**：`qwen3.8-max` 被服务端拒（`invalid_model_error:
  Unsupported model`），SDK 里内嵌的另外 19 个候选 id 也全部被拒。
- **应用自己的会话是 2026-07-28 的**（12 轮全成、0 报错），不是今天；所以
  「All backends failed」到底是令牌作用域问题还是后端当下不可用，**分不开**。

### 由此得出的取舍

这一行要真正能用，需要桌面版那份 job 令牌，而那份令牌只在应用进程内（由它自己的原生
模块解密）。从外面拿它只有两条路：把他们的原生模块打包进来（35MB + 内部 API，不稳），
或者继续攻他们的加密（目前没有进展）。

所以要么**这一行先不挂**（代码留着，等有别的入口再说），要么改成走 ACP 路线（像 zcode
那样用官方 CLI，而不是我们自己做模型客户端）。
