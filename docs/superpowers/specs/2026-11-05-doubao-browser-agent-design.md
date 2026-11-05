# 豆包浏览器 Agent（ACP 行）设计

> 核对时间：2026-11-05
> 状态：设计稿，待实现
> 关联探测记录：`.reference/doubao-app-probe.md`（本机实机探测，素材在 `/tmp/doubao_js`、`.reference/tools/`）

## 1. 要做什么

在 `dsh-acp-agent` 里新增一条 **ACP agent 行**（暂名 `acp-doubao`）：模型的推理来自**豆包消费版桌面端**，交互由我们驱动，输出回到 DSH。

与现有模型行（workbuddy / qoder）不同：那条路是自己登录、自己发 HTTP、自己解析协议；这条路的模型请求**完全由豆包自己发出**（含浏览器端签名），我们只做三件事：

1. **驱动**：把 DSH 的一句话送进豆包的输入框并触发发送；
2. **读取**：把豆包在页面上渲染出来的回答（以及它做的工具动作）读回来；
3. **编排**：把读到的内容翻译成 ACP 事件，交给 DSH 展示、存储、继续下一轮。

豆包网页/桌面端自己就是完整的 agent（会联网搜索、会出图、会用它的连接器）。第一阶段我们**不接管它的工具**：它做 searching/出图/插件动作，我们把这些动作读出来展示；DSH 自己的工具（文件、终端）暂不参与豆包的决策。原因是探明的硬约束，见 §3.5。

## 2. 形态判定与前提

| 问题 | 结论 |
|---|---|
| 有没有官方 headless / CLI？ | 没有。豆包桌面端是自研 Chromium 外壳，无 ACP/CLI 入口 → 形态 A 不可行 |
| 直连接口能不能自己发？ | 不能。请求 URL 上带 `msToken` + `a_bogus`，由页面内的反爬库现算 → 形态 B 不可行（除非把整个页面当运行时） |
| 能不能复用桌面版凭据？ | 能，但**不需要**：我们直接复用桌面端自己的 Chromium，登录态天然在里面 |

于是落在**形态 C′**：**把豆包桌面端当运行时**，我们当壳。这正是用户提的方向。

## 3. 已核实的事实

### 3.1 应用形态

- `/Applications/Doubao.app`（2.24.10，`com.bot.neotix.doubao`）不是 Electron，**没有 app.asar**；是字节自研的 Chromium 外壳（代号 saman/aha），`Contents/MacOS/Doubao` → `Helpers/Doubao Browser.app`（Chromium 147）。
- 桌面端把**网页应用离线打包**在应用内（`Resources/local_webcontents/...`），聊天页是自定义 scheme：`chrome://doubao-chat/chat`。
- 桌面端带 MCP helper（`libmcp_helper.dylib`、`mcp-helper`），是它自己托管 MCP 服务用的。

### 3.2 调试端口（本次方案的地基）

- 直接跑 `Helpers/Doubao Browser.app/.../Doubao Browser --remote-debugging-port=…`：**崩溃**（SIGTRAP），不能脱离应用启动。
- 跑**整个应用**并带参数：外壳会把开关透传给内置 Chromium，端口正常监听：

  ```
  /Applications/Doubao.app/Contents/MacOS/Doubao --remote-debugging-port=<port>
  → Helpers/Doubao Browser.app/.../Doubao Browser --remote-debugging-port=<port> --saman-from-chat=<pid>
  ```

- 端口起来后，`/json/list` 里能看到目标页 `chrome://doubao-chat/chat`，且**登录态天然在**（侧栏显示账号与最近会话）。
- 注意：应用已在运行时，新实例会把请求转给老实例（老实例没有调试端口）→ 要带端口启动，**必须先优雅退出已运行的实例**。

### 3.3 发消息的真实协议（抓包所得）

线上版本已经不用 `/samantha/chat/completion`，改成了：

```
POST https://www.doubao.com/chat/completion
  ?aid=497858&device_id=…&fp=…&language=zh&pc_version=3.44.5&pkg_type=release_version
  &region=CN&samantha_web=1&sys_region=CN&tea_uuid=…&tz_name=…&use-olympus-account=1
  &version_code=20800&web_id=…&web_platform=browser&web_tab_id=…
  &msToken=…&a_bogus=…        ← 反爬库现算的签名，无法在浏览器外复现
```

请求体三块：

- `client_meta`：`conversation_id`、`bot_id`、`last_section_id`、`last_message_index`、`local_permissions[]`
- `messages[]`：`local_message_id`、`content_block[]`（文本块 `block_type: 10000` + `content.text_block.text`）、`message_status`
- `option`：`agent_mode: 2`、`need_deep_think`、`answer_with_suggest`、`model_config{model_item_key:"0", reasoning_effort:3}`、`general_task_param{runtime_type:0, agent_task_param:{}, project_id:"", server_do_compare:true}`、`sse_recv_event_options{support_chunk_delta:true}`、`support_lazy_fetch_stream:true`、`unique_key`、`start_seq` 等

相邻接口：`/im/chain/single`（`cmd: 3100` 拉会话链）、`/im/message/mark_conv_read`（`cmd: 2100` 已读）、`/im/chain/recent_conv`、`/alice/*`（账号、配额、槽位）。

响应是流式（SSE 风格）。**这一层我们不直接消费**——我们读页面渲染结果。

### 3.4 驱动与读取（实机跑通）

- 输入框：桌面端工作模式是 `textarea`（占位符「发消息或按住空格说话…」）；网页版对话模式是 tiptap 的 `contenteditable`。两者都需要**受信输入**（`Input.insertText`），程序化赋值 React 不认。
- 发送：网页版有 `#flow-end-msg-send`；桌面端没有这个 id，靠「输入行最右的图标按钮」定位（脆弱，见 §7）。
- 实机结果：桌面端发「测试一下：今天是星期几？」→ 建立会话 `chrome://doubao-chat/chat/38451492012724226` → 豆包联网搜索（「搜索 1 个关键词，参考 5 篇资料」）→ 回答「今天是星期四。日期：2026 年 11 月 05 日，农历丙午年九月廿七。」**全文与工具卡片都在 DOM 里可读**。

### 3.5 工具：官方机制已探明，缺客户端触发

**服务端整条链路已跑通**（2026-11-05 实测）：

- 注册个人 MCP 连接器：
  `POST /alice/office/skills/manage/connector/create_personal`
  `mcp_config` 的形状是服务端形状（不是 UI 形状）：

  | 字段 | 取值 |
  |---|---|
  | `transport_type` | `1` = STREAMABLE_HTTP，`2` = SSE_HTTP，`3` = STDIO |
  | `stdio_config` | `{ command, params[], env{} }`（STDIO 时必填） |
  | `endpoint` / `headers` | HTTP/SSE 时必填 |

  配套接口：`update_personal`、`connect`、`disconnect`、`set_enabled`、
  `set_conversation_enabled`、`oauth/authorize_url`、`oauth/finish`、`oauth/status`、
  `list_by_user`、`get_detail`、`delete_by_identity`。
- 服务端会把 `stdio_config.command` **原样保存**（我们上传的本机 node 路径被完整存回），
  连接器标记为 `skill_type: 1 (MCP)`、`runtime_types: [2] (本机 PC)`、`enabled: true`，
  `connect` 返回 `connected: true`。
- 预置连接器是 `skill_type: 2 (CLI)`，所以网页端「管理 → 连接器」列表（筛 CLI）里
  **看不到个人 MCP**——这是筛选口径，不是没注册上。

**客户端执行链路也具备，但触发入口在灰度里**：

- 桌面端 `libmcp_helper.dylib` 是 Rust 写的 MCP 客户端（rmcp 3.0），
  连接参数含 `command / args / env / workingDirectory / stdio` 与
  `url / bearerToken / headers / oauthCredentials`——与上面注册的配置一一对应。
- 桌面端原生任务接口：
  `neotix::taskMode::connector::{queryLocalConnectors, authorizeConnector,
  authorizeLocalHttpConnector, cancelAuthorizeConnector, cancelAuthorizeLocalHttpConnector, retryConnector}`，
  以及 `neotix::mcp::{callTool, getAllTools}`。
- 但**公开网页构建里本地运行时客户端是空壳**：`supported: false`、
  `queryLocalConnectors()` 直接返回空数组、`authorize*` 直接 reject；
  真实现只在桌面端专属构建里，而桌面端 UI 没有「我的连接器 / 安装」入口。
  重启桌面端也不会自动认领已启用的连接器。
- 从页面调 JSBridge 的各种调用约定均无响应（超时），这些 native task API
  不对普通 webview 暴露，或需要 appId/白名单。

**结论**：官方 MCP 路径方向正确、服务端完全支持，**唯一缺口是客户端的安装/授权触发**。
第一阶段仍按用户许可的兜底方案：豆包执行它自己的工具，我们拦截并展示；
「豆包调 DSH 工具」作为独立后续任务（§8 给了三条补齐路径）。

## 4. 架构

```
DSH 会话（ACP）
   │  session/prompt { text }
   ▼
DoubaoAgent（src/doubao/agent.ts）
   │  1) 打开/连接桌面端浏览器
   │  2) 定位输入框 → 受信输入 → 触发发送
   │  3) 观察 DOM 增量 → 抽回答与工具动作
   ▼
ACP 事件：session/update(agent_message_chunk) / tool_call / plan
```

组件（各自单一职责，边界清晰）：

| 模块 | 职责 | 依赖 |
|---|---|---|
| `src/doubao/cdp-client.ts` | CDP 传输：连浏览器、attach target、发命令、收事件。零第三方依赖，用 Node 内置 `WebSocket` | 无 |
| `src/doubao/browser.ts` | 桌面端浏览器生命周期：探测端口、必要时带端口重启应用、等待聊天页 target 就绪 | cdp-client |
| `src/doubao/page.ts` | 页面原语：找输入框、受信输入、触发发送、读当前会话、点「停止生成」 | cdp-client |
| `src/doubao/observer.ts` | 注入页面的观察脚本：把 DOM 增量变成结构化事件（回答增量 / 工具动作 / 完成） | 无（纯脚本字符串） |
| `src/doubao/parse.ts` | 从观察事件里抽出「回答文本」「工具动作」「结束」的纯函数（可单测） | 无 |
| `src/doubao/agent.ts` | ACP agent 实现：session/new、session/prompt、cancel、事件转译 | 上面四个 |
| `src/dialects/doubao.ts` | 方言注册（与现有 dialects 同构） | agent |
| `docs/agent-acp/doubao.md` | 协议事实文档（标注核对时间，升级需重核） | — |

### 4.1 观察脚本怎么注入

CDP 的 `Page.addScriptToEvaluateOnNewDocument` **属于会话**：会话断开脚本就没了（实测踩过：注入后另起会话刷新，脚本消失）。所以**注入与后续操作必须在同一个 CDP 会话内完成**。因此 `browser.ts` 必须长期持有一个会话，而不是每次操作临时 attach。

### 4.2 读回答的方式

优先用注入的 `MutationObserver` 盯住回答容器，把增量文本推给宿主；宿主侧由 `parse.ts` 归并。观察脚本要输出：增量文本、工具动作卡片（如「搜索 1 个关键词，参考 5 篇资料」）、本轮结束标记。

DOM 选择器是这套方案最大的脆弱点（网页应用随时改版）。因此**所有选择器集中在一个表里**，并让观察脚本在找不到目标时明确报「选择器失效」而不是静默无输出。

### 4.3 状态与并发

- 一个浏览器实例可开多个会话页；但**一条 ACP 会话 = 一个豆包会话页**，避免串话。
- 同一时刻只允许一个 prompt 在飞（豆包页面本身是单线程对话流）；并发请求排队。

## 5. 错误分类与恢复

| 情况 | 表现 | 处理 |
|---|---|---|
| 应用未运行 | 端口不通 | 带调试端口启动应用，等 target 就绪（最多 N 秒） |
| 应用已在运行且无端口 | 新实例被转给老实例 | 优雅退出老实例再带端口启动（**需要用户知情**：这会关掉用户正在用的豆包） |
| 未登录 | 页面无账号信息 | 报「需要在豆包桌面端登录」，不尝试代登录 |
| 输入框找不到 | 选择器失效 | 报选择器失效（附当前页面快照线索），不猜 |
| 一轮超时 | 无结束标记 | 点「停止生成」→ 报错（区分「上游卡住」与「我们解析不了」） |
| 应用被用户手动关掉 | 连接断开 | 报「浏览器被关闭」 |

失败分类要分清：**上游失败**（豆包侧报错/超时） / **连接中断**（不能当成一次成功的空回答）——与本仓库既有教训一致。

## 6. 测试

- **单测**：`parse.ts` 用录制的观察事件夹具；`cdp-client.ts` 对着假 CDP 服务器测命令/事件路由。
- **夹具**：把一次真实回合的 DOM 增量录下来（不进版本库，放 `.reference/`），单测照着写。
- **实机 live 用例**：参照现有 live 测试的做法，起真应用、发一句真问题、断言「拿到回答 + 拿到工具动作」。live 用例只在真机跑，不进 CI。

## 7. 已知风险

1. **要动用户的应用进程**：带调试端口启动需要先退出正在运行的豆包。这是用户明确选的路线，但实现时要**做成交互式提示**，不做静默杀进程。
2. **DOM 选择器会漂移**：网页应用随灰度改版。缓解：选择器集中一处 + 失效时明确报错 + 文档标注核对时间。
3. **升级即失配**：豆包桌面端升级可能改壳的参数透传方式（`--remote-debugging-port` 是否还被透传）。缓解：启动失败时给出可读的诊断信息（把外壳日志带上）。
4. **模型能力受限于豆包网页**：没有系统提示注入、没有温度/上下文控制，行为由豆包决定。
5. **官方通道仍然更稳**：火山方舟是 OpenAI 兼容的官方接口。本条线的价值在于**用桌面端账号的现成额度与登录态**，不是协议更优。

## 8. 后续（A 路线）怎么再试

服务端已经支持，**只差客户端触发**（见 §3.5）。按代价排序：

1. **挖桌面端专属构建里的本地运行时客户端**（公开网页构建里是空壳）：
   从桌面端加载的 chunk 或 pak 里找到真实现，看它用什么方式调
   `neotix::taskMode::connector::*`，我们在注入脚本里照抄调用 → 触发安装 + 授权。
2. **改用 HTTP 传输型连接器**（`transport_type: 1`），把 MCP 服务器跑在本机
   `127.0.0.1:<port>`，客户端只需「连接」而不必「本地安装」；副作用是 MCP 服务器
   必须对客户端可达（本机可以，远程不行）。
3. **兜底：在提示里与豆包约定一套文本协议**（DSH 注入提示 → 豆包输出
   `<<DSH_TOOL>>{...}` → 我们解析执行 → 回注），脆弱但零依赖。

第一阶段不依赖它们；另起独立任务推进 1 或 2。

## 9. 不做什么

- 不做豆包的反爬/签名复刻（`msToken`/`a_bogus`）。
- 不把豆包的 `app.asar`/网页产物搬进本仓库（抄协议事实，不抄代码）。
- 不在第一阶段接管 DSH 工具执行（见 §3.5）。
- 不在第一阶段支持多浏览器实例并行。
