# 豆包桌面端的 ACP 对接

> 核对时间：2026-11-05
> 素材：本机实机探测（豆包桌面端 2.24.10，`com.bot.neotix.doubao`）+ 真机回合
> 状态：**已实现，已实测。** 预置行 `acp-doubao`；`src/doubao/` 下的服务起真应用、发真问题、
> 把回答与豆包自己的工具动作读回 ACP 帧（2026-11-05 真机跑通，含联网搜索那一轮）。

## 一句话结论

豆包桌面端**不开源，也没有 CLI/ACP 入口**——它是一个自研 Chromium 外壳，把线上网页装进自己的
浏览器里。唯一能接的路子是**把它当运行时**：我们启动它、开它的调试端口、驱动它的聊天页面，
再把页面上长出来的回答读回来。

我们**不复刻**它的模型请求：请求由豆包自己发出，浏览器端的反爬签名（`msToken` / `a_bogus`）
自然成立。

## 应用形态（实测）

```
/Applications/Doubao.app/Contents/MacOS/Doubao          ← 外壳主进程
  └─ Helpers/Doubao Browser.app                          ← Chromium 147（自带网页应用）
  └─ Helpers/{command_helper, mcp-helper, libmcp_helper.dylib, saman_updater, trampoline}
Doubao.app/Contents/Resources/                          ← 只有 icon + manifest.json
```

- **没有 `app.asar`**（不是 Electron），请求代码在**线上网页**里，外壳只贡献原生能力。
- 桌面端把网页应用**离线打包**在应用内，聊天页是自定义 scheme：`doubao://doubao-chat/chat`。
- 聊天页的会话是一个**虚拟列表**：消息是 `div.v_list_row`（另带 `data-observe-row`），
  只有视口内的行在 DOM 里。

## 启动与调试端口（关键事实）

| 做法 | 结果 |
|---|---|
| 直接跑 `Helpers/Doubao Browser.app/.../Doubao Browser --remote-debugging-port=…` | **崩溃**（SIGTRAP），不能脱离应用启动 |
| 跑**整个应用**并带参数 | 外壳把开关**透传**给内置 Chromium，端口正常监听 |

```
/Applications/Doubao.app/Contents/MacOS/Doubao --remote-debugging-port=9555
→ Helpers/Doubao Browser.app/.../Doubao Browser --remote-debugging-port=9555 --saman-from-chat=<pid>
```

端口起来后 `/json/list` 里能看到目标页 `doubao://doubao-chat/chat/<会话id>`，
**登录态天然在里面**（不需要我们注入 Cookie）。

**已在运行时**再带端口启动：新实例会把请求转给老实例（老实例没有端口）→ 端口永远不开。
所以宿主必须先请用户退出豆包，再带端口启动——这一步要交互式提示，不静默杀进程。

## 页面交互（实测）

| 环节 | 事实 |
|---|---|
| 输入框 | 工作模式是 `textarea`（占位「发消息或按住空格说话…」）；对话模式是 tiptap 的 `div[contenteditable=true]` |
| 输入 | **必须受信输入**（CDP `Input.insertText`）；程序化赋值 `.value` 不进应用状态，字段会被清空 |
| 发送 | 网页版有 `#flow-end-msg-send`；桌面端没有 id，取输入行最右的图标按钮 |
| 停止 | 桌面版**渲染不出可识别的停止控件**（按 aria-label/文本都找不到） |
| 提示词回显 | 豆包会**改写提示词**：`2026年11月5日` 回显成 `2026 年 11 月 5 日` → 匹配要去空白 |

## 怎么判断「答完了」

页面上没有可读的「还在生成」信号，只能看**答案本身**：豆包的正文逐块长出来，然后不再变
（实测：生成期间每次轮询都变，之后连续多次不变）。所以完成判据是「答案连续 N 次不变」
（默认 5 次 × 350 ms ≈ 1.75 s），并且答案非空。

## 行文与噪声（实测）

助手行里混着三样东西，都不是正文：

- `免费` —— 页脚；
- `AI 生成可能有误 注意核实` —— 提示横幅；
- 豆包自己的工具活动：`正在搜索`、`找到 6 篇资料`、`搜索 1 个关键词，参考 5 篇资料`。

后两类里的搜索相关行**报成工具动作**（tool_call 帧），不进正文。

## 豆包的模型请求（实测，供将来直连时参考）

线上版本已经不用 `/samantha/chat/completion`，改成 `POST https://www.doubao.com/chat/completion`，
query 里带 `aid=497858`、`device_id`、`fp`，以及反爬库现算的 `msToken` 与 `a_bogus`。
请求体三块：`client_meta`（会话 id / bot id / 最后一条消息位置）、`messages`（`content_block`
数组，文本块 `block_type: 10000`）、`option`（`agent_mode: 2`、`need_deep_think`、
`model_config{model_item_key:"0", reasoning_effort:3}`、`general_task_param` 等）。
相邻接口：`/im/chain/single`（`cmd: 3100` 拉会话链）、`/im/message/mark_conv_read`（`cmd: 2100`）。

**工具没有函数 schema 的位置**：豆包的「工具」是有 catalog 的**连接器**实体，模型请求里体现为
`option.connector_info_list`；预置连接器是 `skill_type: 2 (CLI)`，个人 MCP 是 `1`。
所以「像 CLI 那样直接注入 tools」在豆包这边不存在。

## 个人 MCP（官方机制已探明，客户端触发缺失）

注册接口与配置形状（实测跑通，服务端接受）：

```
POST /alice/office/skills/manage/connector/create_personal
{ name, description, icon_url,
  mcp_config: { transport_type: 1|2|3,        ← 1=STREAMABLE_HTTP, 2=SSE_HTTP, 3=STDIO
                stdio_config: { command, params[], env{} },   ← transport_type=3 时
                endpoint, headers } }           ← http/sse 时
```

服务端把 `command` 原样保存，连接器标记 `skill_type: 1`、`runtime_types: [2]`（本机 PC），
`connect` 返回 `connected: true`。桌面端的 `libmcp_helper.dylib` 是 Rust rmcp 3.0 客户端，
stdio（command/args/env/working_directory）与 http/sse 都支持。

**但这条链在客户端断了**：

- 公开网页构建里，本地运行时客户端是**空壳**（`supported: false`，`queryLocalConnectors()`
  直接返回空数组）；真实现只在桌面端专属构建里，而桌面端 UI 没有「我的连接器 / 安装」入口。
- 桌面端虽然暴露了 `window.__neotix_native_extensions__.towel.createApi(...).call(method, params, cb)`
  这条 JS→原生通道，调任何 neotix 方法都返回 `provider not ready: request timed out waiting for neotix`
  （消费版、工作版都一样）。
- 把连接器 connect + enable + 挂到会话之后，**发消息的请求体里 `connector_info_list` 仍然是空数组**，
  服务端根本没把工具下发给模型；豆包自己的回答是「我没有名为 dsh_echo 的工具」。

也就是说：**服务端完全支持，缺的是客户端的上报与触发**。等官方放开，或找到真正的宿主进程。

## 已知限制

- 工具由豆包自己在**服务端**执行（联网搜索、出图），DSH 的工具不参与模型决策；
  本地 MCP 的路见上节，暂不可用。
- 模型、提示词、温度都不由我们控制（豆包没有 system prompt 入口，也没有函数 schema 位置）。
- 选择器会随网页改版漂移；选择器集中在 `src/doubao/browser.ts` 与 `src/doubao/dom.ts`，
  失效时报「选择器失效」而不是静默无输出。
- 每一轮都会在豆包账号里留下真实对话。

## 共存规则（2026-11-05 实测）

**豆包只能有一个实例。** MAS 版豆包不接受第二个实例：再启动一次，请求会被转给**已经在跑的那个**，
新实例拿不到调试端口（实测：第二个启动没有监听任何端口，日志里是壳进程找不到父进程）。
所以「DSH 换 profile」并不能让豆包并存——约束在豆包这一侧。

能共存的形态是**共用一个带调试端口的豆包**：

- 豆包没在跑 → 我们的 agent 带调试端口启动它。那就是这个窗口，你照常用，DSH 也接得上。
- 豆包在跑、但没带端口 → 我们**不会**干等（以前会等满 30 秒再报「没有应答」），而是立刻告诉你：
  先退出豆包再重试。

**DSH 侧要第二个实例**是可以的：复制一份 profile（目录名不能叫 `desktop`），把 `node_modules` 里的
软链改成绝对路径，再用独立端口起：

```sh
DSH_HOME=~/.dsh dsh --profile <新名字> --port <空闲端口> --no-open
```

这样两个 DSH 实例并存；它们各自连各自的豆包实例——但豆包仍然只有一个。
