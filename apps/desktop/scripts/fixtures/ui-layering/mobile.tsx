import { fixtureEpoch as _tailFixtureEpoch, fixturePath as _tailFixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { ClientUiProvider } from '@agentmux/client-ui'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { AgentMuxAgentSession, AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'
import { MobileMailbox } from '../../../../mobile/src/conversation/MobileMailbox'
import { createBrowserPlatform } from '../../../../mobile/src/platform/browser'
import originalImage from '../../../../mobile/src/assets/dragon.png?inline'
import '@agentmux/client-ui/styles.css'
import '../../../../mobile/src/mobile.css'

// Real MobileMailbox→InputHistoryList→ConversationMessage→AgentMarkdown→
// ConversationImage. Only original external message/image IO facts are supplied.
const imagePath = _tailFixturePath("ui-layering/.agentmux/pasted/original-image.png")
const text = `Read the retained original image.\n\n@${imagePath}`
const message: AgentSessionUserMessage = { id: 'layering-mobile-message', rawId: 'original-input', agentSessionId: 'layering-mobile-session',
  source: { kind: 'captured', submissionId: 'layering-mobile-submission', channel: 'message-tool' }, author: { kind: 'human' },
  content: text, contentParts: [{ kind: 'text', text }], deliveryStatus: 'complete' }
const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: message.agentSessionId, providerId: 'codex', executorId: 'fixture-original',
  hostId: 'local', workspacePath: _tailFixturePath("ui-layering/mobile"), run: { runId: 'layering-mobile-run' }, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
  semanticStatus: { state: 'working', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 1) } }
const platform = { ...createBrowserPlatform({ overlayContainer: () => document.getElementById('mobile-overlays')! }), ownerDocument: document }
const readImage = async (path: string) => {
  if (path !== imagePath) throw new Error('The original exact fixture image path is required')
  if (!originalImage.startsWith('data:image/')) throw new Error('The fixture original image must be bundled with its byte identity')
  return { dataUrl: originalImage }
}
mountThemeRuntime(window)
const events: unknown[] = []
for (const type of ['pointerdown', 'click', 'focusin']) document.addEventListener(type, event => {
  const target = event.target as Element | null
  events.push({ type, trusted: event.isTrusted, tag: target?.tagName, label: target?.closest('button')?.getAttribute('aria-label'),
    scope: target?.closest('[data-overlay-modal-scope]')?.id })
}, true)
createRoot(document.getElementById('root')!).render(<ClientUiProvider platform={platform}>
  <main className="mobile-app"><header className="mobile-sheet-title"><h1>Original conversation</h1>
    <MobileMailbox session={session} connected messages={[message]} platform={platform} describeSpeaker={() => ({ name: 'Original author' })}
      refresh={() => {}} historyScope="layering-mobile-original-history" reading={{ readPastedImage: readImage, workspaceRoot: _tailFixturePath("ui-layering") }}
      readHistory={async input => ({ hostId: 'local', agentSessionId: message.agentSessionId, source: input.source, revision: 'a'.repeat(64),
        availability: input.source === 'captured' ? 'available' : 'empty', order: 'newest-first', items: [], nextCursor: null, budgetBytes: input.maxBytes ?? 128 * 1024,
        kind: 'user-message', userMessages: input.source === 'captured' ? [message] : [], scan: { examined: 1, complete: true },
        ...(input.source === 'native' ? { nativeSource: { providerId: 'codex', nativeSessionId: 'layering-mobile-native' } } : {}) } satisfies AgentSessionHistoryReadPage)}
      onHistoryFill={async () => 'Original draft is retained'} onHistoryCopy={async () => true} />
  </header><p>The original conversation remains behind its communication records.</p></main>
</ClientUiProvider>)
Object.assign(window, { layeringProbe: { read() {
  const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  return { nodes: [...document.querySelectorAll<HTMLElement>('[data-overlay-modal-id]')].filter(node => node.getClientRects().length > 0).map(node => ({
    role: node.getAttribute('role'), modal: node.dataset.overlayModalId, part: node.dataset.overlayModalPart, bounds: rect(node) })),
    active: { tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role'), label: document.activeElement?.getAttribute('aria-label'),
      scope: document.activeElement?.closest('[data-overlay-modal-scope]')?.id }, events,
    messageId: message.id, originalContent: message.content, imageSource: originalImage }
} } })
