import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileApp } from '../../../src/MobileApp'
import { createBrowserPlatform } from '../../../src/platform/browser'
import { nativeDevicePorts } from '../../../src/platform/native/device'
import { getDeviceWorkface } from '../../../src/recovery/device-workface'
import dragon from '../../../src/assets/dragon.png'
import '@agentmux/client-ui/styles.css'

const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: 'session-original', providerId: 'codex', executorId: 'original', hostId: 'local',
  workspacePath: fixturePath("workspace"), run: { runId: 'run-original' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
const host = (window as unknown as { attachmentHost: { call(method: string, params: unknown): Promise<unknown> } }).attachmentHost
const calls: { method: string; params: unknown }[] = []
let connected = true, image = true, loseReply = false, release: (() => void) | null = null, hold = false
nativeDevicePorts.filePicker = { pickFiles: async () => {
  const blob = image ? await (await fetch(dragon)).blob() : new Blob(['这份原始资料由用户在手机上选择。'], { type: 'text/markdown' })
  return { files: [{ name: image ? '头像参考.png' : '本周研究资料与两个方案的比较.md', mimeType: image ? 'image/png' : 'text/markdown', size: blob.size, blob }] }
} } as typeof nativeDevicePorts.filePicker
const client = {
  agentSession: () => session, agentSessions: () => [session], catalog: () => [], onEvent: () => () => {},
  runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original', availability: connected ? 'connected' : 'disconnected' }),
  sessionHistoryPage: async () => ({ agentSessionId: session.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'native-original' }, nextCursor: null,
    items: [{ id: 'original-question', kind: 'user-message', contentParts: [{ kind: 'text', text: '这两个想法，我们先比较哪个更适合做成一个小实验？' }] },
      { id: 'original-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: '可以。把手头资料发给我，我先整理依据，再给你一个小步可验证的建议。' }] }] }),
  sessionTimeline: async () => ({ agentSessionId: session.agentSessionId, revision: 1, items: [] }),
  observeSessionHistory: async () => ({ source: { providerId: 'codex', nativeSessionId: 'native-original' }, dispose() {} }),
  submitAgentPrompt: async () => { throw new Error('This Renderer fixture never sends Agent input.') },
  forwardRpc: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params: structuredClone(params) })
    if (!connected) throw new Error('原 Mac 连接中断；原草稿保留。')
    if (method.startsWith('file.upload')) {
      const result = await host.call(method, params)
      if (method === 'file.upload' && hold) await new Promise<void>(resolve => { release = resolve })
      if (method === 'file.upload' && loseReply) { loseReply = false; throw new Error('上传回执尚未收到；核对原上传确认结果。') }
      return result
    }
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session, displayName: { override: '我的工作搭档', availability: 'observed' } }
    throw new Error('Unsupported controlled observation: ' + method)
  }
} as unknown as AgentMuxHostedClient
localStorage.clear()
getDeviceWorkface().confirmHost({ origin: 'http://127.0.0.1', hostId: 'relay-original' })
getDeviceWorkface().updateNavigation({ selectedSessionId: session.agentSessionId, hostUrl: 'http://127.0.0.1', panel: 'conversation' })
const platform = createBrowserPlatform()
function Scene() {
  const [, refresh] = useState(0)
  Object.assign(window, { attachmentScene: {
    file: () => { image = false }, hold: () => { hold = true }, release: () => { hold = false; release?.() },
    loseReply: () => { loseReply = true }, offline: () => { connected = false; refresh(value => value + 1) },
    reconnect: () => { connected = true; refresh(value => value + 1) },
    facts: () => ({ calls: calls.map(({ method, params }) => ({ method, params: { ...(params as object), dataBase64: undefined } })), record: getDeviceWorkface().snapshot().record })
  } })
  return <MobileApp client={client} connection={connected ? { state: 'connected', message: '已连接原 Mac' } : { state: 'disconnected', message: '连接中断，附件与草稿保留。' }} platform={platform} />
}
createRoot(document.getElementById('root')!).render(<Scene />)
