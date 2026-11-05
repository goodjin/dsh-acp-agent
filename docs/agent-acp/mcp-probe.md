# MCP 委派真机探针记录

> 核对时间：2026-11-05
> 来源：本机实机探测——控制者手工探针（同日）+ 固化为 `tests/live.spec.ts`「MCP 委派探针」组的自动用例（受 `ACP_AGENT_LIVE_ACP=1` 门控）
> 状态：**五家已实测，用例 5/5 通过**（2026-11-05；整个 live 文件 13/13，既有 8 例验收不受影响）。

## 一句话结论

五家全部认 `session/new` 里客户端提供的 stdio MCP 服务器（拉起桥接进程、完成 initialize、要了工具表）；其中四家（codex / claude / qoder / grok）在明确指示下**真的调用了 `delegate` 工具，子代理输出（含随机探针标记）回到工具结果并转述进回答**；**cursor 例外**：连了、列了，但整回合不调用。

## 逐家结论

| Agent | 命令 | 认 MCP（initialize 到桥接） | 列工具（tools/list） | 调 delegate（tools/call） | 结果正确 | 本轮耗时 |
|---|---|---|---|---|---|---|
| codex | `codex-acp` | ✅ | ✅ | ✅ | ✅ 标记回到正文 | 27 s |
| claude | `claude-agent-acp` | ✅ | ✅ | ✅ | ✅ 标记回到正文 | 10 s |
| cursor | `cursor-agent acp --trust` | ✅ | ✅ | ❌ **实测不调** | 回合正常完成 | 16 s |
| qoder | `qoderclicn --acp` | ✅ | ✅ | ✅ | ✅ 标记回到正文 | 121 s |
| grok | `grok`（WebSocket） | ✅ | ✅ | ✅ | ✅ 标记回到正文 | 16 s |

「结果正确」的判定链：桥接把 `tools/call` 转发到假宿主 → 假宿主回的 `output` 里带**每轮随机的探针标记** → 桥接把它放进工具结果 → agent 把标记转述进最终正文。标记是随机的，不真调工具就编不出来。

## 两个必须记录的观察

1. **真机会不会发 `ping`：五家都没发。** 观测垫片记录的全部 agent→桥接方法里没有任何 `ping`（五家各两轮：逐家跑 + 整文件跑，一致）。桥接当前不实现 `ping`（落 `-32601`）因此没有实际影响；这条留观，不据此改桥接。
2. **桥接进程起得来。** CLI 宿主（node）下 agent → 垫片 → 桥接 → 假宿主全链路五家都通。**桌面宿主的坑仍在**：`process.execPath` 可能是 Electron 二进制，缺 `ELECTRON_RUN_AS_NODE` 时桥接不会按 node 跑——生产挂载（`src/factory.ts`）暂未带该变量，装机验证（Task 10）时先查这处。

## 各家前置条件

- **codex / claude**：无参数、无 authenticate 前置——二进制本身就是 stdio ACP 服务。已登录即可（模型侧）。
- **cursor**：必须带 `acp --trust`（裸跑是交互式 agent，不回 JSON-RPC）；必须先 `authenticate`（methodId `cursor_login`，runner 在握手后自动做）；机器上需已完成 `cursor-agent login` 交互登录。
- **qoder**：机器上需已完成 `qoderclicn login`（登录过则 `session/new` 直接成功，反而主动 authenticate 会偶发挂死——方言按需认证）；**必须应答 `session/request_permission`**，不应答 `session/prompt` 会挂到超时（生产用 `bridgePermissions` 应答）；从 IDE 环境拉起需过滤继承的启动环境（`stdioEnvFor`）。
- **grok**：不是 stdio 服务端——生产路径 `GrokServeTransport.create({ command, cwd })` 自己起 `grok agent serve --bind 127.0.0.1:<port> --secret <secret>` 并连 `ws://…?server-key=…`；须先 `initialize` 才让 `session/new`（ACP runner 的握手顺序天然满足）；grok 把 shell 执行委托回客户端，client 要挂 `TerminalService`。

## 探针形态与复跑

- **假宿主**：测试进程内用 `node:http` 起一条回调路由，形状与生产（`src/delegation-route.ts`）一致——只认 `POST /acp-agent/delegation`，验 `x-dsh-delegation-token` 头后回一份 `DelegationResult{output, model, childId}`。断言到「桥接 ↔ 假宿主」为止；真委派实现（superpowers 仓）与真宿主的联调属 Task 10。
- **观测垫片（tee）**：挂载条目的 `args[0]` 是垫片而非桥接路径——垫片拉起真桥接（`bridge/dsh-acp-mcp-bridge.mjs`，一字不改），双向帧记账后原样转发。这是「桥接收到了哪些方法」与「发没发 ping」的唯一观测位；env 与命令形状照抄生产挂载（`tests/mcp-attach.spec.ts` 钉死的那份，stdio 变体不带 `type`）。控制者手工探针已验证过 args[0] 直挂桥接的形态。
- **复跑**：`vitest.config.ts` 把 `tests/live.spec.ts` 排除在默认套件外（`npx vitest run tests/live.spec.ts` 会报 "No test files found"；CLI 的 `--exclude` 只能追加、删不掉那条）。仓根备了 `vitest.live.config.ts`：包含规则与测试别名都从主配置取，只去掉排除那一条。

  ```bash
  ACP_AGENT_LIVE_ACP=1 npx vitest run tests/live.spec.ts --config vitest.live.config.ts
  ```

  早先的复跑方法是现场 `sed '/exclude/d' vitest.config.ts` 拼一份临时配置，那会连带删掉将来任何含 exclude 的行，已换成上面这个固定文件。

- **二进制可用环境变量覆盖**：`THREADHARBOR_CODEX_ACP` / `THREADHARBOR_CURSOR_ACP` / `THREADHARBOR_CLAUDE_ACP` / `THREADHARBOR_QODER_ACP` / `THREADHARBOR_GROK_ACP`。

## 边界与基线

- cursor「不调用」是**实测基线**而非期望值：探针把它钉住（不调 = 用例绿）；它将来「会调了」或「连都不连了」都会红出来，届时更新本文。
- 四家「会调用」的用例依赖模型情绪（明确指示下实测每家两轮都调了）；若某轮没调，用例会红——那是如实报警，不许为了让它绿而放宽。
