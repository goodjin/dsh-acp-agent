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

所以：

- 登录后宿主把清单写进目录的运行时账本，**选择器以运行时清单为准**；
- 清单在**选择器问的时候**就去取（不是等用户先发一条消息），所以打开选择器就能
  看到真实模型与倍率；
- 推理档位轴是**静态声明**的（目录只认 preset 配置里的 `efforts`），运行时清单只
  替换模型条目。

## 登录：插件自己走一遍

WorkBuddy 的账号体系是「浏览器授权 + 站点轮询」，插件复刻了这一套：

1. `POST {站点}/v2/plugin/auth/state?platform=workbuddy` → 拿到 `state` 与一个登录网址。
   这几个请求要带 `X-No-Authorization` 等「不要带鉴权」的头——带旧令牌去要登录凭证会被拒。
2. 浏览器打开那个网址，用户用腾讯云账号授权。
3. 插件轮询 `GET {站点}/v2/plugin/auth/token?state=…`。**「还在登录中」是业务码 11217，不是错误**——把它当错误处理，登录就永远失败。
4. `GET {站点}/v2/plugin/account` 拿账号信息（uid、昵称、企业 id）。
5. 令牌快过期时用 `POST {站点}/v2/plugin/auth/token/refresh` 续期（刷新令牌放在 `X-Refresh-Token` 头里）。

令牌只落在两个地方：宿主进程内存，和 `~/.dsh/workbuddy/credentials.json`（文件 0600、目录 0700）。**令牌不出现在日志、错误消息、路由应答里**，界面那一侧从头到尾没有令牌。

浏览器侧在设置里有一节「WorkBuddy 账号」：问宿主「登了没」，没登录时给一个「去登录」按钮，点了开授权页。宿主那边的两条路由是 `GET /acp-agent/workbuddy/session` 与 `POST /acp-agent/workbuddy/login`。

## 出错时怎么看

| 情况 | 表现 |
|---|---|
| 没登录 | 这一组模型发消息直接失败，消息里说明「WorkBuddy 未登录，请先登录」 |
| 令牌过期 | 收到 401 时自动续期一次并重试一次；再失败就是「真没登录」 |
| 限流（429） | 照实报业务错误码，不自动重试（重试没有意义） |
| 服务端错误（5xx） | 有限重试两次后放弃 |
| 网络断了 | 归成 `TRANSPORT`，宿主会自己重试这一轮——不是「答错了」，是「这一轮丢了」 |

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
