import { createRoot } from 'react-dom/client'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../../../test/fixture-values.mjs'

const sessionId = 'content-width-agent'
const body = '完整原文保持可读。Original content and Copy remain available. 中文🙂'
const reference = 'original-submission-' + 'precise-reference-'.repeat(14)
const timeline = { agentSessionId: sessionId, revision: 1, items: [{ id: reference, agentSessionId: sessionId,
  kind: 'user_message' as const, source: 'user' as const, status: 'complete' as const, title: 'Input',
  content: body, authorHuman: true as const, publicContent: 'confirmed' as const, createdAt: _historyTailFixtureEpoch(0, 0, 1), updatedAt: _historyTailFixtureEpoch(0, 0, 1) }] }
const nativePage = { agentSessionId: sessionId, source: { providerId: 'codex' as const, nativeSessionId: reference },
  nextCursor: null, items: [{ id: reference, kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text: body }] }] }
const copies: string[] = [], controls: string[] = []
api.ui.writeClipboardText = async text => { copies.push(text) }
for (const method of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) {
  api.sessions[method] = async () => { controls.push(method); throw new Error('Read-only layout fixture forbids control') }
}
useAppStore.setState({ sessions: [], timelines: {}, agentNames: {} })
mountThemeRuntime(window)
const root = createRoot(document.getElementById('root')!)
function render(native: boolean, appearance: 'light' | 'dark') {
  updateThemeSelection({ appAppearance: appearance })
  root.render(<DesktopClientUiProvider><ActivityView key={String(native)} sessionId={sessionId} executionHostId="local"
    items={native ? [] : timeline.items} capability="complete-events"
    userMessages={projectSessionUserMessages({ agentSessionId: sessionId, ...(native ? { historyPage: nativePage } : { timeline }) })}
    {...(native ? { nativeHistoryPage: nativePage } : {})} /></DesktopClientUiProvider>)
}
Object.assign(window, { detailsWidthFixture: { render, body, reference, copies, controls } })
render(false, 'light')
