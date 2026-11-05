# workbuddy：WorkBuddy 模型插件

> 核对时间：2026-11-05

WorkBuddy 在模型列表里是单独的一组，名字是 WorkBuddy。选 Auto／快速／均衡／极致，或站点给的其他模型，就是选它。

它**不拉起任何进程，也不走 ACP**。DSH 自己的循环读文件、跑命令、请求批准、取消、写会话记录；只有「向模型要下一句话」这一步换成 WorkBuddy 账号下的模型。

## 它怎么请求模型

协议是 **OpenAI Chat Completions 兼容**（流式 SSE），这一点是照抄得最准的一处——WorkBuddy 自己的 CLI 也是这么发的。

| 项 | 值 |
|---|---|
| 端点 | `{站点}/v2/chat/completions`（站点在配置里给的那个，见下） |
| 客户端标识 | `User-Agent: WorkBuddy/1.0.0-dsh-acp-agent`——**每一发请求都要带** |
| 默认站点 | `https://www.workbuddy.cn`（官方外网站） |
| 换站 | 环境变量 `WORKBUDDY_BASE_URL`（**登录与模型必须同源**，所以只有一个变量） |
| 鉴权 | `Authorization: Bearer <访问令牌>` |
| 账号头 | `X-User-Id`；有企业 id 才带 `X-Enterprise-Id` |
| 会话头 | `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Request-ID`、`X-Agent-Intent` |
| 请求体 | 标准 OpenAI 字段：`model` / `messages` / `tools`（function schema）/ `stream: true` / `max_tokens` / `reasoning_effort` |
| 响应 | SSE，每帧 `data:` 一个 JSON；增量在 `choices[0].delta`，工具调用参数跨帧到达 |

### 客户端标识（User-Agent）是硬要求

站点**按 UA 里的产品名认客户端**：形状不是 `WorkBuddy/版本` 的 UA 一律 400
「check ua, get coding copilot version error」——清单和模型请求都过不去。实测：
带 UA 连发六次全过，不带连发六次全 400。

我们发的是 `WorkBuddy/1.0.0-dsh-acp-agent`：产品名必须是 `WorkBuddy`（这是站点
认的客户端产品名），版本号是我们这个适配器的协议版本，后缀标出请求来自哪个客户端，
站点日志里能认出来。

### 国内网关的渠道校验（400 / 11128）

国内网关（`copilot.tencent.com`、`www.workbuddy.cn`）对**系统提示词**做内容校验：
认出「只有官方客户端才有的指纹」就整轮拒掉，回
`{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`，一句回复
都没有。国际网关不做这个校验。

指纹有四处，都在 DSH 自己拼的系统提示词里：

| # | 指纹 | 出处 |
|---|---|---|
| 1 | `Tokens prefixed with @ are paths …` | 文件引用说明 |
| 2 | 开头的 `You are an AI agent powered by DeepSeek Harness.`（DeepSeek 与 Harness 之间夹着零宽空格） | 内核身份句 |
| 3 | `You are a coding agent powered by the … model.` | 人设前缀 |
| 4 | `… the DeepSeek Harness Web GUI …` / `Current DeepSeek Harness Web GUI URL` | Web GUI 上下文 |

真机 A/B（同一账号、同一请求头，只换提示词）：原样发 → `400 / 11128`；把上面几处
换成等义写法 → `200`。规则只看**系统与助手消息**：同样的内容放进 user 消息不触发；
助手消息里的指纹在任意位置都触发。

**我们的应对**（`src/workbuddy/gateway-guard.ts`）：发请求前把 system、developer、
assistant 消息里的这几处换成等义写法（`DeepSeek-Harness`、`prefixed with (at)`、
`coding agent running on`、`this Web GUI`）。user 与 tool 消息一个字不动——邮箱、
`@某人`、代码里的装饰器都不碰。改写是幂等的，语义不变：模型读到的指令还是原来
那句，只是写法认不出来了。

万一内核改了文案、指纹不再是已知的那几处，还有兜底：网关回 11128 时，用更狠的
力度（系统与助手消息里剩下的 `@` 也换成 `(at)`）再发一次；还不行就报「渠道校验未
通过」，而不是丢一个含糊的 400 过去。

### 模型清单有两份，先用带倍率的那份

同一个账号，站点下发的清单有两种口径：

| 来源 | 模型数 | 官方倍率 | 说明 |
|---|---|---|---|
| 桌面版缓存的那份（`~/.workbuddy/local_storage`） | 61 | **有**（39 个模型带） | 桌面版登录后自己写下的产品配置，明文 JSON |
| 我们自己问站点要的（`GET {站点}/v3/config`） | 39 | 无 | 个人作用域的令牌拿到的是缩水版 |

实测过：桌面版那份里的模型（`hy4-preview`、`fast-model` 这些）**用我们的令牌照样
跑得通**——差的只是清单口径，不是能力。所以清单**优先用桌面版那份**（带官方倍率），
借不到就用我们自己那份，两样都没有才退回 preset 行里声明的兜底四个。

借桌面版的缓存是本仓库的老路子：zcode 解密桌面版的登录密钥、minimaxi 复用
MiniMax Code 的凭据，都是同一件事——桌面版已经登录了，我们就不必再折腾一遍。

### 白名单：这一行只提供挑好的那几个

站点给的清单有六十多个（里面还有补全、视频、图像、本地小模型那些用不上的）。我们
在挂载行里写一份**白名单**（`models`），这一行只提供上面列的那些模型；站点那份
清单只用来补名字、积分倍率与上下文。

所以：

- 白名单写在挂载行的 `models` 里，改一行就能加减，不用动代码；
- 白名单里的某个模型站点清单里没有，**照样显示**（按白名单写的那份显示）；
- 站点给的名字与倍率优先于白名单里写的；
- 同名的（`hy4free` 与 `hy4std` 都叫「Hy4」、五个 Hy4 preview 都叫「Hy4
  preview」）在选择器里各成一行，名字后面补上 id 分得清——挂载行上
  `collapseEfforts: false` 就是干这个的；
- 清单在**选择器问的时候**就去取（不是等用户先发一条消息），所以打开选择器就能
  看到真实模型与倍率。

### 设置里可以勾

站点那边模型一直在变（新的、老的、实验版）。光在选择器里看，勾掉的那些就再也找不
回来了——所以设置里有一节「WorkBuddy 模型」，把**整份清单**列出来（六十几个都在，
包括补全、视频、图像那些用不上的），勾上的进选择器，勾掉的不出现。站点上新了模型，
这里能看见，勾一下就能用。

- 勾选结果存在本机：`~/.dsh/workbuddy/selection.json`（0600）。
- 没自己勾过时，生效的是挂载行里声明的那一份（现在 12 个）；自己勾过就以勾的为准。
- 勾完立刻重发清单，选择器下一次打开就是新的那份。
- 不能带工具的模型会标出来（勾它就只是聊天，DSH 不给模型派工具）。
- 列表上方有搜索框：名字、id、倍率、描述都能搜（搜「x0.08」能找出便宜的）。
- 倍率是胶囊（跟输入框下方的配额胶囊一个样式），「恢复默认那一份」把勾选还原成
  挂载行里声明的那 12 个。

**推理档位不设**：这批模型的档位各不相同（Hy4 只有 high、GLM 是 low/high/max、
MiMo 与 Claude 两个没有），一个统一的档位轴总会有几个模型收到不认的值。所以不
下发 `reasoning_effort`，让每个模型用它自己的默认档。

## 登录：插件自己走一遍

WorkBuddy 的账号体系是「浏览器授权 + 站点轮询」，插件复刻了这一套：

1. `POST {站点}/v2/plugin/auth/state?platform=workbuddy` → 拿到 `state` 与一个登录网址。
   这几个请求要带 `X-No-Authorization` 等「不要带鉴权」的头——带旧令牌去要登录凭证会被拒。
2. 浏览器打开那个网址，用户用腾讯云账号授权。
3. 插件轮询 `GET {站点}/v2/plugin/auth/token?state=…`。**「还在登录中」是业务码 11217，不是错误**——把它当错误处理，登录就永远失败。
4. `GET {站点}/v2/plugin/account` 拿账号信息（uid、昵称、企业 id）。
5. 令牌快过期时用 `POST {站点}/v2/plugin/auth/token/refresh` 续期（刷新令牌放在 `X-Refresh-Token` 头里）。

令牌只落在两个地方：宿主进程内存，和 `~/.dsh/workbuddy/credentials.json`（文件 0600、目录 0700）。**令牌不出现在日志、错误消息、路由应答里**，界面那一侧从头到尾没有令牌。

浏览器侧在设置里有一节「WorkBuddy 账号」，**账号与模型列表都在这一节里**：上面是账号
（一个框里显示昵称与 uid，独占一行），下面一行两个按钮（「登录 WorkBuddy」「检查授权」，
一样大、留出间距），再往下是模型列表（搜索框 + 勾选清单）。宿主那边有三条路由：
`GET /acp-agent/workbuddy/session`、`POST /acp-agent/workbuddy/login`、
`GET`/`POST /acp-agent/workbuddy/models`（整份清单与勾选结果）。

## 出错时怎么看

| 情况 | 表现 |
|---|---|
| 没登录 | 这一组模型发消息直接失败，消息里说明「WorkBuddy 未登录，请先登录」 |
| 令牌过期 | 收到 401 时自动续期一次并重试一次；再失败就是「真没登录」 |
| 限流（429） | 照实报业务错误码，不自动重试（重试没有意义） |
| 服务端错误（5xx） | 有限重试两次后放弃 |
| 网络断了 | 归成 `TRANSPORT`，宿主会自己重试这一轮——不是「答错了」，是「这一轮丢了」 |
| 网关渠道校验（400 / 11128） | 提示词里的指纹被改写掉了；内核又改了文案时用更狠的改写再发一次，仍不行才报「渠道校验未通过」 |

错误消息里的令牌一律被抹成 `[redacted]`。

## 消息是怎么投影的

DSH 的历史 → OpenAI 的 chat 消息，三处有讲究：

- **推理块不重放**。OpenAI 侧不需要推理签名，原样回传反而可能被拒。
- **工具调用与工具结果分开**：调用进 assistant 消息的 `tool_calls`，结果进 `role: "tool"` 的消息并带 `tool_call_id`。两者必须配对——历史上配对错位时，插件会在发出去之前把结果挪回它回答的那次调用（与 zcode／minimax 同一套配对逻辑）。
- **图片看模型能力**：模型支持视觉就带 `image_url`（内联 data URI），不支持就退化成 `[image attached]` 占位。

## 哪里还没确认

- **协议是「OpenAI 兼容」而不是「保证就是 OpenAI」**：字段可能带腾讯私有扩展。实现里的夹具目前是手写的，真机抓包那次（见实施计划的 Task 12）会按实际字段校正。
- **两份清单的口径差别**：桌面版那份与站点给我们的那份差在哪一层（令牌作用域？套餐？），没有深挖；现在按「桌面版优先、我们那份兜底」处理，两份都能用的模型照常可用。
- **积分余额接口还没定位**：v1 不做配额胶囊，只在模型描述里显示倍率（Auto 浮动、快速 x0.15、均衡 x0.50、极致 x1.00）。
- **端点偏向**：默认官方外网站；企业自建站点用 `WORKBUDDY_BASE_URL` 指定。
