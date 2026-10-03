import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConversationNativeThread } from '../../../../../packages/client-ui/src/components/ConversationNativeThread'
import { ClientUiProvider, type ClientUiPlatform } from '../../../../../packages/client-ui/src/platform'
import { AgentComposer } from '../../../../../packages/client-ui/src/components/AgentComposer'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../../../packages/client-ui/src/styles/index.css'
import './outputs-scene.css'

const actions: { path: string; location?: { line: number; column?: number } }[] = []
const platform: ClientUiPlatform = {
  copyText: async text => { await navigator.clipboard.writeText(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: ({ name }) => <span>{name.slice(0, 1)}</span>,
  renderProjectIcon: project => <span>{project.name}</span>, renderProjectLabel: project => <span>{project.name}</span>,
  renderIcon: name => <span data-icon={name} />
}
const files = '[设计说明](deliverables/设计说明.md) · [图表](deliverables/weekly-chart.png) · [PDF](deliverables/research/跨时区协作与长期记忆的调研结果以及需要进一步核实的结论.pdf) · [源代码](src/scheduler.ts:42:3) · [数据](deliverables/data.csv) · [计划](deliverables/plan.md) · [已移走的原文件](deliverables/missing.md) · [补充说明](deliverables/appendix.md)'
function Scene() {
  const [draft, setDraft] = useState('请保留这段尚未发送的草稿。')
  const [notice, setNotice] = useState('')
  return <ClientUiProvider platform={platform}><main className="outputs-scene">
    <header>拾墨 <span>对话</span></header>
    <div className="outputs-scene__reading"><ConversationNativeThread sessionId="fixture-original" workspaceRoot={_hygiene_fixturePath("fixture")}
      page={{ agentSessionId: 'fixture-original', source: { providerId: 'codex', nativeSessionId: 'fixture-native' }, nextCursor: null, items: [
        { id: 'human', kind: 'user-message', contentParts: [{ kind: 'text', text: '把这轮讨论整理成可以继续使用的文件吧。' }] },
        { id: 'answer', kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: '这一轮的说明、图表和待核实项在下面。PDF 里的时间安排仍需你确认；下一步可以从计划中的第一个小任务开始。\n\n' + files }] }
      ] }} openWorkspaceFile={(path, location) => { actions.push({ path, ...(location ? { location } : {}) }); setNotice(path.endsWith('missing.md')
        ? '文件暂时无法确认，原引用已保留。' : `已交给原文件打开入口：${path}`) }} /></div>
    {notice ? <div className="outputs-scene__notice" role="status">{notice}</div> : null}
    <AgentComposer value={draft} onChange={setDraft} disabled={false} placeholder="继续对话" />
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { outputScene: { actions, theme: (light: boolean) => { document.documentElement.classList.toggle('light', light); document.documentElement.style.colorScheme = light ? 'light' : 'dark' } } })
