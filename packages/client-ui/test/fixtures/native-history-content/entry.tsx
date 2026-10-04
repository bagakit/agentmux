import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConversationMessage } from '../../../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { contentFixture, originalBody, record } from './content.js'
import '../../../src/styles/index.css'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import './fixture.css'
const tool = contentFixture({ kind: 'tool-result', name: 'inspect', callId: 'original-tool-call', failed: true, output: originalBody })
const text = contentFixture({ kind: 'text', text: originalBody })
const reasoning = contentFixture({ kind: 'reasoning', text: 'Reasoning 原文\n' + originalBody })
function Scene() {
  const [theme, setTheme] = useState('dark'), [narrow, setNarrow] = useState(false), [copy, setCopy] = useState('')
  document.documentElement.dataset.appearance = theme
  const platform: ClientUiPlatform = { copyText: async value => { setCopy(value); return true }, overlayContainer: () => document.body,
    bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  return <ClientUiProvider platform={platform}><main data-theme={theme}>
    <nav><button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Toggle theme</button><button onClick={() => setNarrow(!narrow)}>Toggle narrow</button>
      <button onClick={() => tool.failNext()}>Fail next tool read</button><span>{copy ? `Copied ${copy.length.toLocaleString()} characters · ${copy.slice(0, 20)} … ${copy.slice(-20)}` : 'Clipboard receipt empty'}</span></nav>
    <section style={{ width: narrow ? 320 : 780 }}>
      <ConversationMessage messageId="before" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content="A normal short answer stays directly readable." status="complete" createdAt={1} />
      <ConversationMessage messageId="original-record" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[{ kind: 'text', text: 'Original surrounding context.' }, tool.part]} status="complete" createdAt={2} nativeResourceRecord={record} readHistoryResource={tool.read} />
      <ConversationMessage messageId="original-text" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[text.part]} status="complete" createdAt={3} nativeResourceRecord={record} readHistoryResource={text.read} />
      <ConversationMessage messageId="original-reasoning" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content={[reasoning.part]} status="complete" createdAt={4} nativeResourceRecord={record} readHistoryResource={reasoning.read} />
      <ConversationMessage messageId="after" speaker={{ role: 'agent', id: 'original-core-session' }} conversationSessionId="original-core-session" name="Assistant" content="The next message and original context remain here." status="complete" createdAt={5} />
    </section>
  </main></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
