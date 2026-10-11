import { useState } from 'react'
import type { AgentSessionHistoryResourceRequest, AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import { mountThemeRuntime, updateThemeSelection } from '../../../src/theme/runtime.js'
import { createRoot } from 'react-dom/client'
import { ConversationMessage } from '../../../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { contentFixture, originalBody, record } from './content.js'
import '../../../src/styles/index.css'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import './fixture.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
const sample = new Image()
sample.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960"><rect width="1440" height="960" fill="#e9efeb"/><rect x="80" y="80" width="1280" height="800" rx="32" fill="#fcfdfa"/><text x="140" y="190" font-family="sans-serif" font-size="24" fill="#627568">DESIGN STUDY / ORIGINAL RECORDED IMAGE</text><text x="140" y="270" font-family="sans-serif" font-size="54" fill="#1c3225">A readable working surface</text><path d="M420 480H1020M720 480V690" stroke="#39745c" stroke-width="5"/><rect x="140" y="370" width="300" height="220" rx="20" fill="#edf2ee"/><rect x="570" y="370" width="300" height="220" rx="20" fill="#39745c"/><rect x="1000" y="370" width="300" height="220" rx="20" fill="#edf2ee"/><text x="180" y="490" font-family="sans-serif" font-size="30" fill="#1c3225">Original source</text><text x="615" y="490" font-family="sans-serif" font-size="30" fill="white">Local view</text><text x="1045" y="490" font-family="sans-serif" font-size="30" fill="#1c3225">Exact reference</text></svg>`)
await sample.decode()
const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 960; canvas.getContext('2d')!.drawImage(sample, 0, 0)
const raster = canvas.toDataURL('image/png'), image = contentFixture({ kind: 'resource', resourceType: 'image', reference: raster }, 'deferred-image')
let failImage = false
const readDeferredImage = async (input: AgentSessionHistoryResourceRequest): Promise<AgentSessionHistoryResourceReadResult> => {
  if (input.representation !== 'image') return image.read(input)
  if (input.expectedReference !== image.part.reference) throw new Error('The original outer reference must be retained.')
  if (failImage) { failImage = false; throw new Error('Original image source temporarily unavailable. Retry keeps this reference.') }
  const dataBase64 = raster.split(',')[1]!
  return { agentSessionId: 'original-core-session', source: record.source, recordId: record.recordId, turnId: record.turnId, partIndex: input.partIndex, reference: image.part.reference, result: { status: 'read', mimeType: 'image/png', dataBase64, byteLength: atob(dataBase64).length, width: 1440, height: 960 } }
}
const tool = contentFixture({ kind: 'tool-result', name: 'inspect', callId: 'original-tool-call', failed: true, output: originalBody })
const text = contentFixture({ kind: 'text', text: originalBody })
const reasoning = contentFixture({ kind: 'reasoning', text: 'Reasoning 原文\n' + originalBody })
function Scene() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark'), [narrow, setNarrow] = useState(false), [copy, setCopy] = useState('')
  document.documentElement.dataset.appearance = theme
  const platform: ClientUiPlatform = { copyText: async value => { setCopy(value); return true }, overlayContainer: () => document.body,
    bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  return <ClientUiProvider platform={platform}><main data-theme={theme}>
    <nav><button onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); updateThemeSelection({ appAppearance: next }) }}>Toggle theme</button><button onClick={() => setNarrow(!narrow)}>Toggle narrow</button>
      <button onClick={() => tool.failNext()}>Fail next tool read</button><button onClick={() => { failImage = true }}>Fail next image read</button><span>Controlled resource transport · production image face</span><span>{copy ? `Copied ${copy.length.toLocaleString()} characters · ${copy.slice(0, 20)} … ${copy.slice(-20)}` : 'Clipboard receipt empty'}</span></nav>
    <section style={{ width: narrow ? 332 : 780 }}>
      <ConversationMessage messageId="before" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content="A normal short answer stays directly readable." status="complete" createdAt={1} />
      <ConversationMessage messageId="original-image" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[{ kind: 'text', text: 'The original recorded design is available here.' }, image.part]} status="complete" createdAt={2} nativeResourceRecord={record} readHistoryResource={readDeferredImage} />
      <ConversationMessage messageId="original-record" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[{ kind: 'text', text: 'Original surrounding context.' }, tool.part]} status="complete" createdAt={2} nativeResourceRecord={record} readHistoryResource={tool.read} />
      <ConversationMessage messageId="original-text" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[text.part]} status="complete" createdAt={3} nativeResourceRecord={record} readHistoryResource={text.read} />
      <ConversationMessage messageId="original-reasoning" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[reasoning.part]} status="complete" createdAt={4} nativeResourceRecord={record} readHistoryResource={reasoning.read} />
      <ConversationMessage messageId="after" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content="The next message and original context remain here." status="complete" createdAt={5} />
    </section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
