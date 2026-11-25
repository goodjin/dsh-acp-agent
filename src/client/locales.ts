/**
 * Agent-related locale keys extracted from dsh-client for the ACP agent plugin.
 * Only keys used by the browser-side agent UI (quota pills, visibility panel,
 * model label, handover, switch progress, recovery). The conversation-area features
 * (answer card, session-tail file cards) moved to @goodjin2/dsh-chat-area.
 */

export type ProgressKey = Extract<ClientLocaleKey, `progress.${string}`>

export const NAMESPACE = 'acpAgentClient'

export type ClientLocaleKey =
  | 'handover.title' | 'handover.open'
  | 'lostInput.title' | 'lostInput.hint' | 'lostInput.copy' | 'lostInput.copied'
  | 'lostInput.resend' | 'lostInput.sending' | 'lostInput.sent' | 'lostInput.failed'
  | 'lostInput.attachments' | 'lostInput.emptyText'
  | 'quota.fiveHour.label' | 'quota.weekly.label'
  | 'quota.fiveHour.title' | 'quota.weekly.title' | 'quota.resetAt'
  | 'quota.minimaxi.fiveHour.title' | 'quota.minimaxi.weekly.title'
  | 'quota.minimaxi.unlimited' | 'quota.minimaxi.unlimitedTitle'
  | 'quota.minimaxi.credit' | 'quota.minimaxi.creditTitle'
  | 'quota.codex.window.title' | 'quota.codex.credit' | 'quota.codex.creditTitle'
  | 'quota.claude.fiveHour.title' | 'quota.claude.weekly.title'
  | 'quota.claude.credit' | 'quota.claude.creditTitle'
  | 'quota.deepseek.credit' | 'quota.deepseek.creditTitle'
  | 'quota.grok.weekly.title' | 'quota.grok.weekly.title.tier'
  | 'quota.login.cta' | 'quota.login.code' | 'quota.login.title'
  | 'recovery.interrupted.note' | 'recovery.interrupted.expand'
  | 'acpVisibility.label' | 'acpVisibility.title' | 'acpVisibility.intro'
  | 'acpVisibility.summary' | 'acpVisibility.summaryNone' | 'acpVisibility.reset'
  | 'acpVisibility.reload' | 'acpVisibility.retry' | 'acpVisibility.loading'
  | 'acpVisibility.empty' | 'acpVisibility.noModels' | 'acpVisibility.agentHiddenHint'
  | 'acpVisibility.agentToggleNamed' | 'acpVisibility.modelToggleNamed'
  | 'acpVisibility.agentFailure'
  | 'acpVisibility.error.missing' | 'acpVisibility.error.shape' | 'acpVisibility.error.failed'
  | 'acpVisibility.refresh.button' | 'acpVisibility.refresh.named' | 'acpVisibility.refresh.refreshing'
  | 'acpVisibility.refresh.upstream' | 'acpVisibility.refresh.familyWindow' | 'acpVisibility.refresh.unverified'
  | 'acpVisibility.refresh.reread' | 'acpVisibility.refresh.codexHint' | 'acpVisibility.refresh.busy'
  | 'acpVisibility.refresh.failed' | 'acpVisibility.refresh.qoderHint' | 'acpVisibility.refresh.anotherPlugin'
  | 'acpVisibility.refresh.notLoggedIn' | 'acpVisibility.refresh.authFailed' | 'acpVisibility.refresh.emptyList'
  | 'acpVisibility.refresh.timeout' | 'acpVisibility.refresh.spawnFailed' | 'acpVisibility.refresh.sessionFailed'
  | 'acpVisibility.refresh.loginHint'
  | 'progress.preparing' | 'progress.loading' | 'progress.ready'
  | 'storagePosture.local'

export const zh: Record<ClientLocaleKey, string> = {
  'handover.title': '已切换到 {target}，对话已移到新会话',
  'handover.open': '打开新会话',
  'lostInput.title': '本轮请求未送达',
  'lostInput.hint': '这条请求在进入对话记录之前失败了，原文还在这里。',
  'lostInput.copy': '复制原文',
  'lostInput.copied': '已复制',
  'lostInput.resend': '重新发送',
  'lostInput.sending': '正在重发…',
  'lostInput.sent': '已重发',
  'lostInput.failed': '重发失败：{reason}',
  'lostInput.attachments': '原请求带附件或没有文本，只能复制原文。',
  'lostInput.emptyText': '（原请求没有文本）',
  'quota.fiveHour.label': '5小时 {percent}%',
  'quota.weekly.label': '周 {percent}%',
  'quota.fiveHour.title': 'GLM 套餐 5 小时窗口：已用 {used} / {total}',
  'quota.weekly.title': 'GLM 套餐周窗口：已用 {used} / {total}',
  'quota.resetAt': '，{reset} 重置',
  'quota.minimaxi.fiveHour.title': 'MiniMax 套餐 5 小时窗口：剩余 {percent}%',
  'quota.minimaxi.weekly.title': 'MiniMax 套餐周窗口：剩余 {percent}%',
  'quota.minimaxi.unlimited': '不限',
  'quota.minimaxi.unlimitedTitle': 'MiniMax 套餐窗口：不限',
  'quota.minimaxi.credit': '积分',
  'quota.minimaxi.creditTitle': 'MiniMax 套餐剩余积分：{remaining}',
  'quota.codex.window.title': 'Codex 套餐窗口：已用 {percent}%',
  'quota.codex.credit': '积分',
  'quota.codex.creditTitle': 'Codex 按量积分余额：{remaining}',
  'quota.claude.fiveHour.title': 'Claude 套餐 5 小时窗口：已用 {percent}%',
  'quota.claude.weekly.title': 'Claude 套餐 7 天窗口：已用 {percent}%',
  'quota.claude.credit': '按量',
  'quota.claude.creditTitle': 'Claude 按量已用：{used} / {limit}',
  'quota.deepseek.credit': '余额',
  'quota.grok.weekly.title': 'Grok 周窗口：已用 {percent}%',
  'quota.grok.weekly.title.tier': 'Grok（{tier}）周窗口：已用 {percent}%',
  'quota.deepseek.creditTitle': 'DeepSeek 账户余额 ¥{recharge}；赠送 ¥{bonus}{extra}',
  'quota.login.cta': '去授权',
  'quota.login.code': '授权码 {code}',
  'quota.login.title': '登录过期或没有登录：点开授权链接重新登录，授权完成后这一行会自动恢复',
  'recovery.interrupted.note': '本轮被中断，{steps} 项过程内容已折叠',
  'recovery.interrupted.expand': '展开本轮过程',
  'acpVisibility.label': '提供方与模型',
  'acpVisibility.title': '屏蔽提供方与模型',
  'acpVisibility.intro': '被屏蔽的提供方不会出现在模型选择里（输入框的模型入口与 /model 弹窗）；提供方未被屏蔽时，也可以只屏蔽它下面的个别模型。屏蔽只作用于选择列表：官方设置里的「模型」照旧列出全部、密钥不受影响，随时可以恢复。选择保存在这台机器上，换浏览器不会丢。',
  'acpVisibility.summary': '已屏蔽 {agents} 个提供方、{models} 个模型。',
  'acpVisibility.summaryNone': '当前没有屏蔽任何提供方或模型。',
  'acpVisibility.reset': '全部恢复',
  'acpVisibility.reload': '重新读取',
  'acpVisibility.retry': '重试',
  'acpVisibility.loading': '正在读取提供方与模型清单……',
  'acpVisibility.empty': '这台主机没有列出任何模型提供方。',
  'acpVisibility.noModels': '这个提供方没有可列出的模型。',
  'acpVisibility.agentHiddenHint': '整个提供方已屏蔽；取消勾选后才能单独调整它下面的模型。',
  'acpVisibility.agentToggleNamed': '屏蔽提供方：{name}',
  'acpVisibility.modelToggleNamed': '屏蔽模型：{name}',
  'acpVisibility.agentFailure': '模型目录读取失败：{message}',
  'acpVisibility.error.missing': '这台主机没有提供模型目录（remote.session.modelCatalog）。',
  'acpVisibility.error.shape': '模型目录的返回形状不符合预期。',
  'acpVisibility.error.failed': '读取模型目录失败：{detail}',
  'acpVisibility.refresh.button': '刷新模型列表',
  'acpVisibility.refresh.named': '刷新 {name} 的模型列表',
  'acpVisibility.refresh.refreshing': '正在刷新模型列表……',
  'acpVisibility.refresh.upstream': '已刷新：{total} 个模型（新增 {added} 个）。',
  'acpVisibility.refresh.familyWindow': '{count} 个新增模型的上下文窗口沿用同族声明值。',
  'acpVisibility.refresh.unverified': '{count} 个模型未验证上下文窗口。',
  'acpVisibility.refresh.reread': '已重读模型目录；该提供方暂不支持从上游拉取清单。',
  'acpVisibility.refresh.codexHint': 'Codex 的上游清单刷新在 dsh-codex 插件的设置段。',
  'acpVisibility.refresh.busy': '刷新正在进行中，请等它完成。',
  'acpVisibility.refresh.failed': '刷新失败：{reason}',
  'acpVisibility.refresh.qoderHint': 'Qoder 的上游清单刷新在 dsh-qoder 插件的设置段。',
  'acpVisibility.refresh.anotherPlugin': '这个提供方由另一个插件挂载，请到对应插件的设置段刷新。',
  'acpVisibility.refresh.notLoggedIn': '外部 agent 没有登录，读不到模型清单：{reason}',
  'acpVisibility.refresh.authFailed': '外部 agent 的登录校验没通过，读不到模型清单：{reason}',
  'acpVisibility.refresh.emptyList': '外部 agent 回应了，但清单是空的（可能是账号没有可用模型，或登录已失效）。',
  'acpVisibility.refresh.timeout': '读取模型清单超时：外部 agent 没有在期限内回答。',
  'acpVisibility.refresh.spawnFailed': '拉起外部 agent 失败：{reason}',
  'acpVisibility.refresh.sessionFailed': '外部 agent 没有给出模型清单：{reason}',
  'acpVisibility.refresh.loginHint': '请先在终端运行 {command}，然后再刷新。',
  'progress.preparing': '正在准备打开新会话 · {target}',
  'progress.loading': '正在读新会话的历史 · {target}',
  'progress.ready': '新会话已就绪，正在切换 · {target}',
  'storagePosture.local': '设置保存在本机',
}

export const en: Record<ClientLocaleKey, string> = {
  'handover.title': 'Switched to {target}; the conversation moved to the new session',
  'handover.open': 'Open the new session',
  'lostInput.title': 'This request was not delivered',
  'lostInput.hint': 'It failed before it entered the transcript. The text is still here.',
  'lostInput.copy': 'Copy text',
  'lostInput.copied': 'Copied',
  'lostInput.resend': 'Send again',
  'lostInput.sending': 'Sending again…',
  'lostInput.sent': 'Sent again',
  'lostInput.failed': 'Sending again failed: {reason}',
  'lostInput.attachments': 'The original request had attachments or no text, so only the text can be copied.',
  'lostInput.emptyText': '(the original request had no text)',
  'quota.fiveHour.label': '5h {percent}%',
  'quota.weekly.label': 'wk {percent}%',
  'quota.fiveHour.title': 'GLM plan five-hour window: {used} / {total} used',
  'quota.weekly.title': 'GLM plan weekly window: {used} / {total} used',
  'quota.resetAt': ', resets {reset}',
  'quota.minimaxi.fiveHour.title': 'MiniMax plan five-hour window: {percent}% left',
  'quota.minimaxi.weekly.title': 'MiniMax plan weekly window: {percent}% left',
  'quota.minimaxi.unlimited': 'unlimited',
  'quota.minimaxi.unlimitedTitle': 'MiniMax plan window: unlimited',
  'quota.minimaxi.credit': 'credits',
  'quota.minimaxi.creditTitle': 'MiniMax plan credits remaining: {remaining}',
  'quota.codex.window.title': 'Codex plan window: {percent}% used',
  'quota.codex.credit': 'credits',
  'quota.codex.creditTitle': 'Codex credit balance: {remaining}',
  'quota.claude.fiveHour.title': 'Claude plan five-hour window: {percent}% used',
  'quota.claude.weekly.title': 'Claude plan 7-day window: {percent}% used',
  'quota.claude.credit': 'extra',
  'quota.claude.creditTitle': 'Claude extra usage: {used} / {limit}',
  'quota.deepseek.credit': 'Balance',
  'quota.grok.weekly.title': 'Grok weekly window: {percent}% used',
  'quota.grok.weekly.title.tier': 'Grok ({tier}) weekly window: {percent}% used',
  'quota.deepseek.creditTitle': 'DeepSeek account balance ¥{recharge}; bonus ¥{bonus}{extra}',
  'quota.login.cta': 'Authorize',
  'quota.login.code': 'code {code}',
  'quota.login.title': 'Login expired or missing: open the authorization link to sign in again; this row comes back on its own once you have',
  'recovery.interrupted.note': 'This turn was interrupted; {steps} process items are folded',
  'recovery.interrupted.expand': 'Show this turn’s process',
  'acpVisibility.label': 'Providers & models',
  'acpVisibility.title': 'Hide providers and models',
  'acpVisibility.intro': 'A hidden provider disappears from the model pickers (the composer model menu and the /model popup); while a provider stays listed, individual models can be hidden too. Hiding only affects the pickers: the official Models settings keep listing everything and no key is touched, so restoring never asks for a key again. This choice is stored on this machine and survives a browser switch.',
  'acpVisibility.summary': 'Hidden providers: {agents}; hidden models: {models}.',
  'acpVisibility.summaryNone': 'No providers or models are hidden.',
  'acpVisibility.reset': 'Restore all',
  'acpVisibility.reload': 'Reload',
  'acpVisibility.retry': 'Retry',
  'acpVisibility.loading': 'Reading providers and models…',
  'acpVisibility.empty': 'This host lists no model providers.',
  'acpVisibility.noModels': 'This provider lists no models.',
  'acpVisibility.agentHiddenHint': 'The whole provider is hidden; clear its checkbox to adjust individual models.',
  'acpVisibility.agentToggleNamed': 'Hide provider: {name}',
  'acpVisibility.modelToggleNamed': 'Hide model: {name}',
  'acpVisibility.agentFailure': 'Model catalog failed: {message}',
  'acpVisibility.error.missing': 'This host offers no model catalog (remote.session.modelCatalog).',
  'acpVisibility.error.shape': 'The model catalog answered in an unexpected shape.',
  'acpVisibility.error.failed': 'Reading the model catalog failed: {detail}',
  'acpVisibility.refresh.button': 'Refresh model list',
  'acpVisibility.refresh.named': 'Refresh the model list of {name}',
  'acpVisibility.refresh.refreshing': 'Refreshing the model list…',
  'acpVisibility.refresh.upstream': 'Refreshed: {total} models ({added} new).',
  'acpVisibility.refresh.familyWindow': '{count} new models use the context window declared for their family.',
  'acpVisibility.refresh.unverified': '{count} models have no verified context window.',
  'acpVisibility.refresh.reread': 'The model catalog was re-read; this provider cannot fetch an upstream list yet.',
  'acpVisibility.refresh.codexHint': 'Codex’s upstream refresh lives in the dsh-codex plugin’s settings.',
  'acpVisibility.refresh.busy': 'A refresh is already running; wait for it to finish.',
  'acpVisibility.refresh.failed': 'Refresh failed: {reason}',
  'acpVisibility.refresh.qoderHint': 'Qoder’s upstream refresh lives in the dsh-qoder plugin’s settings.',
  'acpVisibility.refresh.anotherPlugin': 'This provider is mounted by another plugin — refresh it from that plugin’s settings.',
  'acpVisibility.refresh.notLoggedIn': 'The external agent is not logged in, so its model list cannot be read: {reason}',
  'acpVisibility.refresh.authFailed': 'The external agent refused the login step, so its model list cannot be read: {reason}',
  'acpVisibility.refresh.emptyList': 'The external agent answered, but the list is empty (the account may have no models available, or the login is no longer valid).',
  'acpVisibility.refresh.timeout': 'Reading the model list timed out — the external agent did not answer in time.',
  'acpVisibility.refresh.spawnFailed': 'Could not start the external agent: {reason}',
  'acpVisibility.refresh.sessionFailed': 'The external agent did not publish a model list: {reason}',
  'acpVisibility.refresh.loginHint': 'Run {command} in a terminal first, then refresh again.',
  'progress.preparing': 'Preparing to open the new session · {target}',
  'progress.loading': 'Reading the new session’s history · {target}',
  'progress.ready': 'New session ready, switching · {target}',
  'storagePosture.local': 'Settings are stored on this machine',
}

/**
 * 其余六种界面语言。
 *
 * 本插件的词典历来只落 zh 与 en；新增的刷新文案按宿主的八种界面语言补全——
 * 六种新词典以 en 为底、只覆盖新键：旧键没有现成译本，照旧回落英文（与改动前
 * 一个非中/英用户看到的一致），新键则是各自的翻译。整本重译旧键不在这件事的
 * 范围里，也不该顺手机器翻译。
 */
export const ja: Record<ClientLocaleKey, string> = {
  ...en,
  'acpVisibility.refresh.button': 'モデルリストを更新',
  'acpVisibility.refresh.named': '{name} のモデルリストを更新',
  'acpVisibility.refresh.refreshing': 'モデルリストを更新中…',
  'acpVisibility.refresh.upstream': '更新しました：{total} 個のモデル（新規 {added} 個）。',
  'acpVisibility.refresh.familyWindow': '新規 {count} 個のモデルは同族に宣言されたコンテキスト窓を使います。',
  'acpVisibility.refresh.unverified': '{count} 個のモデルはコンテキスト窓が未検証です。',
  'acpVisibility.refresh.reread': 'モデルカタログを再読み込みしました。このプロバイダーはまだ上流一覧の取得に対応していません。',
  'acpVisibility.refresh.codexHint': 'Codex の上流更新は dsh-codex プラグインの設定にあります。',
  'acpVisibility.refresh.busy': '更新が既に実行中です。完了をお待ちください。',
  'acpVisibility.refresh.failed': '更新に失敗しました：{reason}',
  'acpVisibility.refresh.qoderHint': 'Qoder の上流更新は dsh-qoder プラグインの設定にあります。',
  'acpVisibility.refresh.anotherPlugin': 'このプロバイダーは別のプラグインがマウントしています。そのプラグインの設定から更新してください。',
  'acpVisibility.refresh.notLoggedIn': '外部エージェントがログインしていないため、モデル一覧を読み取れません: {reason}',
  'acpVisibility.refresh.authFailed': '外部エージェントのログイン確認が失敗したため、モデル一覧を読み取れません: {reason}',
  'acpVisibility.refresh.emptyList': '外部エージェントは応答しましたが、一覧が空です（アカウントで利用できるモデルがない、またはログインが失効している可能性があります）。',
  'acpVisibility.refresh.timeout': 'モデル一覧の取得がタイムアウトしました（外部エージェントが時間内に応答しませんでした）。',
  'acpVisibility.refresh.spawnFailed': '外部エージェントを起動できませんでした: {reason}',
  'acpVisibility.refresh.sessionFailed': '外部エージェントはモデル一覧を返しませんでした: {reason}',
  'acpVisibility.refresh.loginHint': 'まずターミナルで {command} を実行してから、もう一度更新してください。',
}

export const es: Record<ClientLocaleKey, string> = {
  ...en,
  'acpVisibility.refresh.button': 'Actualizar lista de modelos',
  'acpVisibility.refresh.named': 'Actualizar la lista de modelos de {name}',
  'acpVisibility.refresh.refreshing': 'Actualizando la lista de modelos…',
  'acpVisibility.refresh.upstream': 'Actualizado: {total} modelos ({added} nuevos).',
  'acpVisibility.refresh.familyWindow': '{count} modelos nuevos usan la ventana de contexto declarada para su familia.',
  'acpVisibility.refresh.unverified': '{count} modelos no tienen ventana de contexto verificada.',
  'acpVisibility.refresh.reread': 'Se volvió a leer el catálogo de modelos; este proveedor aún no puede obtener una lista del origen.',
  'acpVisibility.refresh.codexHint': 'La actualización de Codex está en los ajustes del complemento dsh-codex.',
  'acpVisibility.refresh.busy': 'Ya hay una actualización en curso; espera a que termine.',
  'acpVisibility.refresh.failed': 'Error al actualizar: {reason}',
  'acpVisibility.refresh.qoderHint': 'La actualización de Qoder está en los ajustes del complemento dsh-qoder.',
  'acpVisibility.refresh.anotherPlugin': 'Este proveedor lo monta otro complemento; actualízalo desde los ajustes de ese complemento.',
  'acpVisibility.refresh.notLoggedIn': 'El agente externo no ha iniciado sesión, así que no se puede leer su lista de modelos: {reason}',
  'acpVisibility.refresh.authFailed': 'El agente externo rechazó el paso de inicio de sesión, así que no se puede leer su lista de modelos: {reason}',
  'acpVisibility.refresh.emptyList': 'El agente externo respondió, pero la lista está vacía (puede que la cuenta no tenga modelos disponibles o que el inicio de sesión ya no sea válido).',
  'acpVisibility.refresh.timeout': 'La lectura de la lista de modelos agotó el tiempo: el agente externo no respondió a tiempo.',
  'acpVisibility.refresh.spawnFailed': 'No se pudo iniciar el agente externo: {reason}',
  'acpVisibility.refresh.sessionFailed': 'El agente externo no publicó una lista de modelos: {reason}',
  'acpVisibility.refresh.loginHint': 'Ejecuta {command} en una terminal primero y vuelve a actualizar.',
}

export const fr: Record<ClientLocaleKey, string> = {
  ...en,
  'acpVisibility.refresh.button': 'Actualiser la liste des modèles',
  'acpVisibility.refresh.named': 'Actualiser la liste des modèles de {name}',
  'acpVisibility.refresh.refreshing': 'Actualisation de la liste des modèles…',
  'acpVisibility.refresh.upstream': 'Actualisé : {total} modèles ({added} nouveaux).',
  'acpVisibility.refresh.familyWindow': '{count} nouveaux modèles utilisent la fenêtre de contexte déclarée pour leur famille.',
  'acpVisibility.refresh.unverified': '{count} modèles n’ont pas de fenêtre de contexte vérifiée.',
  'acpVisibility.refresh.reread': 'Le catalogue de modèles a été relu ; ce fournisseur ne peut pas encore récupérer de liste amont.',
  'acpVisibility.refresh.codexHint': 'La mise à jour amont de Codex se trouve dans les réglages du plugin dsh-codex.',
  'acpVisibility.refresh.busy': 'Une actualisation est déjà en cours ; attendez qu’elle se termine.',
  'acpVisibility.refresh.failed': 'Échec de l’actualisation : {reason}',
  'acpVisibility.refresh.qoderHint': 'La mise à jour amont de Qoder se trouve dans les réglages du plugin dsh-qoder.',
  'acpVisibility.refresh.anotherPlugin': 'Ce fournisseur est monté par un autre plugin — actualisez-le depuis les réglages de ce plugin.',
  'acpVisibility.refresh.notLoggedIn': 'L\'agent externe n\'est pas connecté, sa liste de modèles est donc illisible : {reason}',
  'acpVisibility.refresh.authFailed': 'L\'agent externe a refusé l\'étape de connexion, sa liste de modèles est donc illisible : {reason}',
  'acpVisibility.refresh.emptyList': 'L\'agent externe a répondu, mais la liste est vide (le compte n\'a peut-être aucun modèle disponible, ou la connexion n\'est plus valide).',
  'acpVisibility.refresh.timeout': 'La lecture de la liste de modèles a expiré : l\'agent externe n\'a pas répondu à temps.',
  'acpVisibility.refresh.spawnFailed': 'Impossible de lancer l\'agent externe : {reason}',
  'acpVisibility.refresh.sessionFailed': 'L\'agent externe n\'a pas publié de liste de modèles : {reason}',
  'acpVisibility.refresh.loginHint': 'Lancez d\'abord {command} dans un terminal, puis actualisez à nouveau.',
}

export const de: Record<ClientLocaleKey, string> = {
  ...en,
  'acpVisibility.refresh.button': 'Modelliste aktualisieren',
  'acpVisibility.refresh.named': 'Modelliste von {name} aktualisieren',
  'acpVisibility.refresh.refreshing': 'Modelliste wird aktualisiert…',
  'acpVisibility.refresh.upstream': 'Aktualisiert: {total} Modelle ({added} neu).',
  'acpVisibility.refresh.familyWindow': '{count} neue Modelle übernehmen das für ihre Familie deklarierte Kontextfenster.',
  'acpVisibility.refresh.unverified': '{count} Modelle haben kein verifiziertes Kontextfenster.',
  'acpVisibility.refresh.reread': 'Der Modellkatalog wurde neu gelesen; dieser Anbieter kann noch keine Upstream-Liste abrufen.',
  'acpVisibility.refresh.codexHint': 'Die Codex-Aktualisierung befindet sich in den Einstellungen des dsh-codex-Plugins.',
  'acpVisibility.refresh.busy': 'Eine Aktualisierung läuft bereits; warte auf ihren Abschluss.',
  'acpVisibility.refresh.failed': 'Aktualisierung fehlgeschlagen: {reason}',
  'acpVisibility.refresh.qoderHint': 'Die Qoder-Aktualisierung befindet sich in den Einstellungen des dsh-qoder-Plugins.',
  'acpVisibility.refresh.anotherPlugin': 'Dieser Anbieter wird von einem anderen Plugin bereitgestellt — aktualisieren Sie ihn in dessen Einstellungen.',
  'acpVisibility.refresh.notLoggedIn': 'Der externe Agent ist nicht angemeldet, daher lässt sich seine Modellliste nicht lesen: {reason}',
  'acpVisibility.refresh.authFailed': 'Der externe Agent hat den Anmeldeschritt abgelehnt, daher lässt sich seine Modellliste nicht lesen: {reason}',
  'acpVisibility.refresh.emptyList': 'Der externe Agent hat geantwortet, die Liste ist aber leer (das Konto hat vielleicht keine Modelle verfügbar, oder die Anmeldung ist nicht mehr gültig).',
  'acpVisibility.refresh.timeout': 'Das Lesen der Modellliste hat zu lange gedauert – der externe Agent hat nicht rechtzeitig geantwortet.',
  'acpVisibility.refresh.spawnFailed': 'Der externe Agent konnte nicht gestartet werden: {reason}',
  'acpVisibility.refresh.sessionFailed': 'Der externe Agent hat keine Modellliste veröffentlicht: {reason}',
  'acpVisibility.refresh.loginHint': 'Führe zuerst {command} in einem Terminal aus und aktualisiere danach erneut.',
}

export const ru: Record<ClientLocaleKey, string> = {
  ...en,
  'acpVisibility.refresh.button': 'Обновить список моделей',
  'acpVisibility.refresh.named': 'Обновить список моделей {name}',
  'acpVisibility.refresh.refreshing': 'Обновление списка моделей…',
  'acpVisibility.refresh.upstream': 'Обновлено: моделей {total} (новых {added}).',
  'acpVisibility.refresh.familyWindow': '{count} новых моделей используют окно контекста, заявленное для их семейства.',
  'acpVisibility.refresh.unverified': 'У {count} моделей не проверено окно контекста.',
  'acpVisibility.refresh.reread': 'Каталог моделей перечитан; этот поставщик пока не умеет получать список у вышестоящего сервиса.',
  'acpVisibility.refresh.codexHint': 'Обновление Codex находится в настройках плагина dsh-codex.',
  'acpVisibility.refresh.busy': 'Обновление уже выполняется; дождитесь его завершения.',
  'acpVisibility.refresh.failed': 'Не удалось обновить: {reason}',
  'acpVisibility.refresh.qoderHint': 'Обновление Qoder находится в настройках плагина dsh-qoder.',
  'acpVisibility.refresh.anotherPlugin': 'Этот поставщик подключён другим плагином — обновите его в настройках этого плагина.',
  'acpVisibility.refresh.notLoggedIn': 'Внешний агент не авторизован, поэтому его список моделей прочитать нельзя: {reason}',
  'acpVisibility.refresh.authFailed': 'Внешний агент отклонил шаг авторизации, поэтому его список моделей прочитать нельзя: {reason}',
  'acpVisibility.refresh.emptyList': 'Внешний агент ответил, но список пуст (у аккаунта может не быть доступных моделей, или вход больше недействителен).',
  'acpVisibility.refresh.timeout': 'Чтение списка моделей истекло по времени — внешний агент не ответил вовремя.',
  'acpVisibility.refresh.spawnFailed': 'Не удалось запустить внешнего агента: {reason}',
  'acpVisibility.refresh.sessionFailed': 'Внешний агент не опубликовал список моделей: {reason}',
  'acpVisibility.refresh.loginHint': 'Сначала выполните {command} в терминале, затем обновите снова.',
}

export const pt: Record<ClientLocaleKey, string> = {
  ...en,
  'acpVisibility.refresh.button': 'Atualizar lista de modelos',
  'acpVisibility.refresh.named': 'Atualizar a lista de modelos de {name}',
  'acpVisibility.refresh.refreshing': 'Atualizando a lista de modelos…',
  'acpVisibility.refresh.upstream': 'Atualizado: {total} modelos ({added} novos).',
  'acpVisibility.refresh.familyWindow': '{count} modelos novos usam a janela de contexto declarada para a sua família.',
  'acpVisibility.refresh.unverified': '{count} modelos não têm janela de contexto verificada.',
  'acpVisibility.refresh.reread': 'O catálogo de modelos foi relido; este provedor ainda não consegue obter uma lista da origem.',
  'acpVisibility.refresh.codexHint': 'A atualização do Codex fica nas configurações do plugin dsh-codex.',
  'acpVisibility.refresh.busy': 'Uma atualização já está em andamento; aguarde a conclusão.',
  'acpVisibility.refresh.failed': 'Falha ao atualizar: {reason}',
  'acpVisibility.refresh.qoderHint': 'A atualização do Qoder fica nas configurações do plugin dsh-qoder.',
  'acpVisibility.refresh.anotherPlugin': 'Este provedor é montado por outro plugin — atualize-o nas configurações desse plugin.',
  'acpVisibility.refresh.notLoggedIn': 'O agente externo não está com login feito, então a lista de modelos não pode ser lida: {reason}',
  'acpVisibility.refresh.authFailed': 'O agente externo recusou a etapa de login, então a lista de modelos não pode ser lida: {reason}',
  'acpVisibility.refresh.emptyList': 'O agente externo respondeu, mas a lista está vazia (a conta pode não ter modelos disponíveis, ou o login não é mais válido).',
  'acpVisibility.refresh.timeout': 'A leitura da lista de modelos expirou — o agente externo não respondeu a tempo.',
  'acpVisibility.refresh.spawnFailed': 'Não foi possível iniciar o agente externo: {reason}',
  'acpVisibility.refresh.sessionFailed': 'O agente externo não publicou uma lista de modelos: {reason}',
  'acpVisibility.refresh.loginHint': 'Execute {command} em um terminal primeiro e atualize de novo.',
}

type Params = Readonly<Record<string, string | number>>

function interpolate(template: string, params?: Params): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`))
}

export type RuntimeT = (key: string, params?: Params) => string

export const fallbackT: RuntimeT = (key, params) => {
  const k = key as ClientLocaleKey
  return interpolate(zh[k] ?? key, params)
}

function makeT(locale: Record<ClientLocaleKey, string>): RuntimeT {
  return (key, params) => {
    const k = key as ClientLocaleKey
    return interpolate(locale[k] ?? key, params)
  }
}

export function registerClientLocales(register: (dictionaries: Record<string, Record<string, string>>) => void): void {
  register({
    zh: { ...zh },
    en: { ...en },
    ja: { ...ja },
    es: { ...es },
    fr: { ...fr },
    de: { ...de },
    ru: { ...ru },
    pt: { ...pt },
  })
}
