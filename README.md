# @goodjin2/dsh-acp-agent

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects external coding agents to DSH's native session interface. Supports GLM (ZCode), MiniMax, Codex, Claude, Grok, Cursor, and Qoder.

## What it does

**Host side** (loads in the DSH process):

- **ACP agent framework** — transports (stdio, WebSocket), per-agent dialects, frame projection, terminal & file sub-protocols
- **GLM (ZCode) model client** — decrypts local ZCode login, calls GLM Coding Plan, streams responses
- **MiniMax model client** — reads/refreshes MiniMax Code credentials, calls managed gateway
- **Preset dispatch** — registers external agents as DSH presets, takes over sessions, routes turns, handles model switching
- **Quota endpoints** — host-side GLM/MiniMax/Codex/Claude quota routes (credentials never leave the host process)
- **Roster filter** — hides marked presets from the new-session picker
- **Mermaid asset** — serves the Mermaid rendering runtime on demand

**Browser side** (`./client` entry, auto-loaded by DSH Web via the `dsh.client` declaration):

- **Quota pills** — the GLM/MiniMax/Codex/Claude pills under the composer, polling the host routes
- **Model visibility panel** — settings section to hide providers and models from the pickers
- **Model label** — the composer's model chip
- **Switch feedback** — handover notice and switch progress bar when the conversation moves to a new session
- **Turn recovery** — the expand button for interrupted no-text turns; resend for requests that never entered the transcript
- **ACP process view** — terminal/file step rendering for external agent turns. It
  works standalone and, when `@goodjin2/dsh-chat-area` is installed, plugs into that
  package's `assistant-step` wrapper through the seat
  `conversation.chat.node.acp-segment-renderer` (chat-area owns the declaration).

## MiniMax login: refresh, and what happens when it can't

The MiniMax client borrows the local MiniMax Code login
(`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`) and refreshes it through
the same official OAuth core — same credential store, same cross-process lock — so a
refresh here never invalidates the desktop app or the CLI.

When the refresh token itself is dead, retrying is pointless, so the plugin now says
*where to authorize* instead of failing quietly:

- `resolveCredential` raises `MiniMaxLoginRequiredError` (`reason: 'missing' | 'expired'`);
- the quota route (`GET /threadharbor/minimax/quota`) answers
  `{ ok: false, needsLogin: true, login: { url, userCode?, expiresInSec? } }`;
- a model request that cannot authenticate puts the authorization link into the error
  it streams into the conversation, so the link is clickable where the failure shows up.

The link comes from the same device-authorization flow the desktop app uses
(`POST /oauth2/device/code` → `verification_uri_complete`). The plugin starts one in the
background and waits at most 3 s for the prompt, because while MiniMax Code is running it
holds the auth lock and our login has to queue: the first response may carry just the
account origin, and the next poll (30 s later) the complete link with the user code. Once
the user authorizes, the official core writes the new credential back to the shared
`auth.json` and the next call simply works. Tokens never enter these payloads, log lines
or error strings.

## When a row doesn't mount: the self-report seam

A module that cannot be imported takes its whole row down with it, and it cannot report that
itself. So this package ships one leaf module (`./health`, row `threadharbor-health`) that
imports nothing from the package — it still loads and speaks while everything else is broken.

After boot it prints one line naming what is missing and why:

```
acp-agent health: 12/13 行已挂载；未挂载 1 行 — threadharbor-minimaxi-quota（MiniMax 套餐额度接口）：SyntaxError: TypeScript parameter property is not supported in strip-only mode
```

and serves the same ledger as JSON at `GET /threadharbor/health`:
`{ ok, mounted, total, disabled, rows: [{ id, what, status, detail }] }`. `status` is one of
`mounted`, `failed` (module never imported, or `apply` threw), `pending` (waiting on injected
services), `absent` (the composed row never reached the loader tree) or `disabled` (turned off
on purpose — not a failure). No tokens or credentials are in that payload.

Why it exists: on 2026-11-03 a constructor parameter property in `src/minimaxi/credential.ts`
made every row importing it fail under DSH's strip-only TypeScript loader. The host half and
the browser half vanished together with nothing visible in any log; the cause was only found
by probing whether a quota route existed. Two gates now stand in front of that: the audit row
above, and `tests/entry-loadability.spec.ts`, which imports every host entry with a real
`node` (no transform) before a change can ship.

## 0.3.0 — what moved out

Generic conversation-area UI moved to [`@goodjin2/dsh-chat-area`](https://github.com/threadharbor/dsh-chat-area)
in 2026-11: the answer card, the conversation file cards, the Mermaid renderer and
its host route, and the short session-ID bar. This package keeps the ACP side and
no longer exports `./mermaid-asset` — if your profile still lists
`@goodjin2/dsh-acp-agent/mermaid-asset`, replace it with
`@goodjin2/dsh-chat-area/mermaid-asset` (or drop it; chat-area's own bundle patch
declares it).

Browser layering, when both packages are installed: `assistant-step` renders the
**lowest** priority entry, so chat-area wraps at `-50` and this package at `-40`
(fallback for acp-agent-only installs). Only chat-area declares the seat; a second
declaration throws and is swallowed, which used to make the result depend on
assembly order.

## Install

From GitHub Packages:

```sh
# Set up auth (one-time)
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
echo "@goodjin:registry=https://npm.pkg.github.com" >> ~/.npmrc

dsh plugin --profile web add @goodjin2/dsh-acp-agent
```

Or add to your profile's `package.json`:

```json
{
  "dependencies": { "@goodjin2/dsh-acp-agent": "^0.1.0" }
}
```

Then add the agent presets you want to your profile's `cordis.patch.yml`. This repo ships its own `cordis.patch.yml` with the seven agent preset rows, the browser-half roster row (`acp-agent-client`, a bare package-name row — DSH only treats rows named exactly that way as client entries), the host-side `roster-filter` / `zcode-quota` / `minimaxi-quota` / `codex-quota` / `claude-quota` mounts (moved here from the threadharbor umbrella in 2026-11), and the `health` self-report row. See the [installation guide](https://github.com/goodjin/threadharbor/blob/main/docs/install-plugins.zh.md) for details.

## Requirements

- DSH ≥ 0.2.1-rc.2
- Node ≥ 22.19 (or ≥ 24)
- For GLM: ZCode desktop app installed and logged in
- For MiniMax: MiniMax Code installed and logged in

## Publish

```sh
gh auth refresh -h github.com -s write:packages
NODE_AUTH_TOKEN=$(gh auth token) npm publish --registry https://npm.pkg.github.com
```

## License

MIT
