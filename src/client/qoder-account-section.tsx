import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkBuddyAccountSlotHost } from './workbuddy-account-section.tsx'

export function QoderAccountSection(): ReactNode {
  const [status, setStatus] = useState('正在读取账号状态…')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  async function refresh() {
    try {
      const res = await fetch('/acp-agent/qoder-global/session')
      const data = await res.json()
      if (!alive.current) return
      setStatus(data.authenticated ? `已登录 ${data.account?.nickname ?? ''}` : data.reason ?? (data.pending ? '等待浏览器授权…' : '未登录'))
      setBusy(data.pending === true)
      if (data.authenticated) setUrl('')
    } catch { if (alive.current) setStatus('无法读取 Qoder 账号状态') }
  }
  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])
  async function login() {
    setBusy(true)
    try {
      const res = await fetch('/acp-agent/qoder-global/login', { method: 'POST' })
      const data = await res.json()
      if (!data.ok || typeof data.url !== 'string') throw new Error()
      if (!alive.current) return
      setUrl(data.url); setStatus('请打开授权页面完成登录')
      window.open(data.url, '_blank', 'noopener')
    } catch { if (alive.current) { setStatus('Qoder 登录未能启动，请重试'); setBusy(false) } }
  }
  return <div>
    <p>{status}</p>
    <button type="button" disabled={busy} onClick={() => { void login() }}>登录 Qoder 国际版</button>
    {url && <p><a href={url} target="_blank" rel="noopener noreferrer">打开授权页面</a></p>}
  </div>
}
export function registerQoderAccountSection(slots: WorkBuddyAccountSlotHost): void {
  slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'acp-agent-qoder-account',
    order: 121, label: () => 'Qoder 国际版账号' }, QoderAccountSection))
}
