import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConversationView } from '../../../src/components/ConversationView.js'
import { ConversationMessage } from '../../../src/components/ConversationMessage.js'
import { InputMailboxRecords } from '../../../src/components/InputMailboxRecords.js'
import { ClientUiProvider, type ClientUiPlatform } from '../../../src/platform.js'
import { projectConversationReading } from '../../../src/lib/conversation-records.js'
import type { useAgentInputMailbox } from '../../../src/lib/use-agent-input-mailbox.js'
import { SemanticIcon } from '../../../src/theme/icons.js'
import { mountThemeRuntime, updateThemeSelection } from '../../../src/theme/runtime.js'
import { body, capturedItem, context, mailboxItem, wire } from '../browser-context-reading.js'
import '../../../../../apps/desktop/src/renderer/src/styles/tokens.css'
import '../../../src/styles/index.css'
import './scene.css'

const copies: string[] = []
const platform: ClientUiPlatform = {
  copyText: async text => { copies.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => <span className="reading-proof__avatar"><SemanticIcon name="object.agent" size={14} /></span>,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
const item = capturedItem(), reading = projectConversationReading({ agentSessionId: 'recipient', timeline: { agentSessionId: 'recipient', revision: 1, items: [item] } })
const originalMailbox = mailboxItem()
if (originalMailbox.kind === 'controlled') {
  const ref = { key: originalMailbox.intent.key, waitGeneration: 1 }
  originalMailbox.receipt = { key: ref.key, ref, persistence: 'confirmed', control: { ref, state: 'enabled', at: context.capturedAt },
    admission: null, status: 'waiting', observation: 'owned' }
}
const mailbox: ReturnType<typeof useAgentInputMailbox> = { scope: 'recipient', items: [originalMailbox], failures: [], page: null,
  loading: false, error: null, refresh: async () => {}, loadEarlier: async () => {}, hasMore: false }
const resourceBytes = new TextEncoder().encode(JSON.stringify({ kind: 'text', text: wire }))
const resourceHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', resourceBytes)), byte => byte.toString(16).padStart(2, '0')).join('')
const resource = { kind: 'resource', resourceType: 'text', reference: 'original:complete',
  content: { kind: 'text', encoding: 'json-utf8', byteLength: resourceBytes.length, sha256: resourceHash } } as const
const resourceRecord = { source: { providerId: 'codex', nativeSessionId: 'original-native' }, recordId: 'original-complete-input' }

function App() {
  const [scene, setScene] = useState('conversation')
  Object.assign(window, { readingProof: { setScene, setTheme: (mode: 'light' | 'dark') => updateThemeSelection({ appAppearance: mode }), copies, expectedCopy: wire, expectedBody: body } })
  return <ClientUiProvider platform={platform}>
    <main className="reading-proof" data-reading-scene={scene}>
      <header className="reading-proof__head"><SemanticIcon name="object.agent" size={15} /><strong>Review Agent</strong><span>{scene === 'mailbox' ? 'Sent inputs' : 'Conversation'}</span></header>
      <div className="reading-proof__content">
        {scene === 'mailbox' ? <InputMailboxRecords mailbox={mailbox} hostId="local" /> : <>
          <ConversationView sessionId="recipient" records={reading.records} originalRecords={reading.originalRecords} expandSubmissions />
          <ConversationMessage messageId="complete-input" recordedIdentity speaker={{ role: 'unknown', id: 'unknown' }} content={[resource]}
            nativeResourceRecord={resourceRecord} inputContext={context} inputContextSource="host-capture"
            readHistoryResource={async input => ({ agentSessionId: 'recipient', ...resourceRecord, partIndex: input.partIndex, reference: resource.reference,
              result: { status: 'fragment', encoding: 'json-utf8', dataBase64: btoa(String.fromCharCode(...resourceBytes)), byteLength: resourceBytes.length,
                offsetBytes: 0, totalBytes: resourceBytes.length, nextOffsetBytes: null, sha256: resourceHash } })} />
        </>}
      </div>
    </main>
  </ClientUiProvider>
}
mountThemeRuntime(window, { appAppearance: 'dark' })
createRoot(document.getElementById('root')!).render(<App />)
