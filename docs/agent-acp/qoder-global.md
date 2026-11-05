# Qoder 国际版模型适配器

核对：2026-11-05。本机 Qoder.app 0.5.3（global），worker 1.1.79-hotfix.11，SDK 1.0.59-alpha.9。

## 范围与使用

新增 `acp-qoder-global` / `agent: qoder-global`，走 DSH 原生工具循环；国内版 `acp-qoder` 仍走 `qoderclicn --acp`。
设置 → Qoder 国际版账号 → 登录 → 浏览器授权。模型选择器选 Qoder 国际版 / Auto。
浏览器未自动弹出时，可点设置里的「打开授权页面」。轮询五分钟到期后允许重试。

凭据单独保存在 `$DSH_HOME/qoder-global/credentials.json`（默认 `~/.dsh`），目录 0700、文件 0600。
不读取、不改写桌面 App 的 `auth.v1.dat` 或 CLI 的 `.auth/user`；凭据写入与刷新共用跨进程锁，临时文件原子替换。
只支持本次核对的官方国际版端点，不支持借用国内版令牌、企业 VPC 或任意自定义 baseUrl。

## 从安装包定位请求

`app.asar` 为 183 MB。直接读取 ASAR header 的文件表，按偏移提取 SDK 和 main 模块，避免整包解压的缺失资源问题。
真正的请求实现已经在 `app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`，约 33 MB。
开头的字符串解码器为 base64 + 循环 XOR。只解码字符串并按上下文查看，不执行抽取出的代码，不将厂商 bundle 放进本仓库。

关键路径：

- `Mot` / `oWi`：HTTP 模型地址默认 `https://api2-v2.qoder.sh/model/v1/chat/completions`。
- `Wat.openResponse`：Bearer，`X-Request-ID` / `X-Session-ID`，JSON 请求，SSE 响应；401 刷新一次。
- `OFn`：OpenAI 消息/工具结构，另加 `stream_options.include_usage`、`metadata.context`，可选 `metadata.business`。
- `Wat.payloadsFromResponse`：处理 SSE error、JSON error、OpenAI choices 和终止标记。
- `Rpl`：PKCE S256，浏览器 `/device/selectAccounts`；宿主向 `openapi.qoder.sh/api/v1/deviceToken/poll` 提交 nonce/verifier。
- 登录待完成是 HTTP 404；成功响应令牌在顶层 `token`，不是 `data.data`。
- 续期 `POST /api/v1/deviceToken/refresh`，body 为 refresh_token + machine_id；新令牌字段是 `device_token`。
- CLI `.auth/user` 由 WASM 加密，带跨进程锁；桌面账号另存 Electron 数据目录，不能假定两者共享明文 token。

worker 同时存在 legacy、HTTP、gRPC 三条模型传输。此实现仅使用 HTTP 路径，不把 gRPC/legacy 的封装当 OpenAI SSE。
模型目录 `/api/v2/model/list?Encode=1` 仍走旧签名/编码链路，本版未复制这套签名；只声明 worker 默认的 auto，不套用国内版模型目录、倍率或权限。
官方 ACP 是另一条已存在的完整 agent 接入方式：https://docs.qoder.com/cli/acp 。

## 实测与限制

已验证：

- 官方未授权 poll：HTTP 404，`errorCode: NotFound`（2026-11-05）。
- 官方模型端点无 Bearer：HTTP 401，`{"error":"unauthorized"}`。
- 测试覆盖 PKCE、404 等待、成功外壳、取消、并发旋转、已存在目录收紧、401 单次重试、工具参数分帧、usage、错误/截断流、路由准入、重复登录与卸载取消。
- 仓库类型检查、全量测试与客户端构建通过（最终 1169 通过、3 跳过）。
- 独立 DSH 宿主装载日志实测 18/18，国际版预置确认为 transport=model。
- 受保护路由的真实 HTTP 验证未执行：自动审批拒绝从临时宿主启动日志读取访问令牌；路由准入与响应由单测覆盖。

待账号授权实测：成功登录和 refresh 响应、auto 的实际模型回合、真实 SSE 工具往返及模型权限。
成功响应夹具来自本机 worker 的字段，不冒充服务端抓包。实现拒绝错误/空流/没有 finish_reason 的截断流，不会把它们显示为成功。
HTTP 429/503 和排队响应会明确失败，暂不实现 worker 的私有排队轮询；流开始后不自动重发，避免重复生成或工具调用。
