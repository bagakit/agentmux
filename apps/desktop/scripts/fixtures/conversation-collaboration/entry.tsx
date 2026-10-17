import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ConversationMessageAvatar } from '../../../src/renderer/src/components/ConversationMessageAvatar'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const page: AgentSessionHistoryPage = await (await fetch('/page.json')).json()
const copies: string[] = []
const platform: ClientUiPlatform = { copyText: async text => { copies.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: props => <ConversationMessageAvatar {...props} />,
  renderIcon: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null }
const speech = (id: string, text: string) => ({ id, kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text, contentEligibility: 'public' as const }] })
function Scene() {
  const [revision, setRevision] = useState(0), [draft, setDraft] = useState('保留这份尚未发送的草稿。')
  const [dark, setDark] = useState(true)
  const scene = { ...page, items: [speech('intro', '我会核对消息来源、折叠交互和窄分屏阅读，再汇总结果。'), ...page.items,
    speech('conclusion', '协作结果已收到。可以展开每条回报查看细节，接下来继续完成对话模式的优化。'),
    ...(revision ? [speech('later', '追加的新进度不会打断已经展开的阅读。')] : [])] }
  const projection = projectConversationReading({ agentSessionId: page.agentSessionId, executionHostId: 'local', historyPage: scene })
  Object.assign(window, { collaborationPreview: { copies, append: () => setRevision(1), theme: (value: 'dark'|'light') => { setDark(value === 'dark'); updateThemeSelection({ appAppearance: value }) } } })
  return <main className="collaboration-scene"><header><strong>对话</strong><span>Subagent 协作回报</span><button onClick={() => { updateThemeSelection({ appAppearance: dark ? 'light' : 'dark' }); setDark(!dark) }}>切换明暗</button></header>
    <section className="collaboration-scene__reading"><ClientUiProvider platform={platform}><ConversationView page={scene} sessionId={page.agentSessionId} executionHostId="local"
      records={projection.records} originalRecords={projection.originalRecords}
      describeSpeaker={speaker => ({ name: speaker.id === page.agentSessionId ? 'Codex' : speaker.id, providerId: 'codex' })} /></ClientUiProvider></section>
    <footer><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /><span>预览 · 原生记录读取与实际对话组件</span></footer>
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
