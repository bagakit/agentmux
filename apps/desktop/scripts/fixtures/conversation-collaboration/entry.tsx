import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import type { ConversationHistoryResourceReader } from '@agentmux/client-ui/components/ConversationResourceImage'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ConversationMessageAvatar } from '../../../src/renderer/src/components/ConversationMessageAvatar'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const page: AgentSessionHistoryPage = await (await fetch('/page.json')).json()
const copies: string[] = []
const resourceBytes = new TextEncoder().encode(JSON.stringify({ kind: 'text', text: '按需读取的协作详情，保留原记录。', contentEligibility: 'public' }))
const resourceDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', resourceBytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const resourceReads: string[] = []
const readResource: ConversationHistoryResourceReader = async input => {
  resourceReads.push(input.recordId)
  return { source: input.source, recordId: input.recordId, partIndex: input.partIndex, reference: input.expectedReference,
    result: { status: 'fragment', encoding: 'json-utf8', dataBase64: btoa(String.fromCharCode(...resourceBytes)), byteLength: resourceBytes.length, offsetBytes: 0, totalBytes: resourceBytes.length, sha256: resourceDigest, nextOffsetBytes: null } }
}
const captured: AgentTimelineItem = { id: 'reply-snapshot', agentSessionId: page.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete',
  title: 'Original reply observation', content: '检查完成，继续完善对话阅读。', createdAt: 750, updatedAt: 750 }
const platform: ClientUiPlatform = { copyText: async text => { copies.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: props => <ConversationMessageAvatar {...props} />,
  renderIcon: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null }
const speech = (id: string, text: string) => ({ id, kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text, contentEligibility: 'public' as const }] })
function Scene() {
  const [revision, setRevision] = useState(0), [draft, setDraft] = useState('保留这份尚未发送的草稿。')
  const [dark, setDark] = useState(true)
  const scene: AgentSessionHistoryPage = { ...page, items: [{ ...speech('intro', '我会核对消息来源、折叠交互和窄分屏阅读，再汇总结果。'), startedAt: 0 },
    { id: 'process', kind: 'activity', startedAt: 500, contentParts: [{ kind: 'reasoning', text: '核对消息与阅读边界。' }] }, ...page.items,
    { ...page.items[0]!, id: 'preview-resource', startedAt: 6_000, contentParts: [{ kind: 'resource', resourceType: 'text', reference: 'recorded:report-resource', content: { encoding: 'json-utf8', kind: 'text', byteLength: resourceBytes.length, sha256: resourceDigest } }] },
    speech('conclusion', '协作结果已收到。可以展开每条回报查看细节，接下来继续完成对话模式的优化。'),
    ...(revision ? [speech('later', '追加的新进度不会打断已经展开的阅读。')] : [])] }
  const projection = projectConversationReading({ agentSessionId: page.agentSessionId, executionHostId: 'local', historyPage: scene, timeline: { agentSessionId: page.agentSessionId, sourceHostId: 'local', revision: 1, items: [captured] } })
  Object.assign(window, { collaborationPreview: { copies, resourceReads, append: () => setRevision(1), theme: (value: 'dark'|'light') => { setDark(value === 'dark'); updateThemeSelection({ appAppearance: value }) } } })
  return <main className="collaboration-scene"><header><strong>对话</strong><span>Subagent 协作回报</span><button onClick={() => { updateThemeSelection({ appAppearance: dark ? 'light' : 'dark' }); setDark(!dark) }}>切换明暗</button></header>
    <section className="collaboration-scene__reading"><ClientUiProvider platform={platform}><ConversationView page={scene} sessionId={page.agentSessionId} executionHostId="local"
      records={projection.records} originalRecords={projection.originalRecords} readHistoryResource={readResource} renderProcess={props => <NativeProcessObservation {...props} compact />}
      describeSpeaker={speaker => ({ name: speaker.id === page.agentSessionId ? 'Codex' : speaker.id, providerId: 'codex' })} /></ClientUiProvider></section>
    <footer><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /><span>预览 · 原生记录读取与实际对话组件</span></footer>
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
