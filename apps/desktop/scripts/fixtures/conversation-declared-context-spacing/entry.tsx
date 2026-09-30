import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
import './preview.css'
const scene: { page: AgentSessionHistoryPage; draft: string } = await (await fetch('/public-scene.json')).json()
const copies: string[] = [], controls: string[] = []
api.ui.writeClipboardText = async text => { copies.push(text) }
for (const name of ['submitPrompt', 'write', 'resume', 'recover', 'stop'] as const) api.sessions[name] = async () => { controls.push(name); throw Error('Private reading prohibits Run control') }
const messages = projectSessionUserMessages({ agentSessionId: scene.page.agentSessionId, historyPage: scene.page })
const preview = { scene, copies, controls, renderCount: 0, rerender: () => {} }
Object.assign(window, { declaredContextPreview: preview })
function Scene() {
  const [draft, setDraft] = useState(scene.draft), [displayState, setDisplayState] = useState<'done' | 'working'>('done')
  preview.renderCount++
  useEffect(() => { preview.rerender = () => setDisplayState('working') }, [])
  return <main className="declared-context-preview"><header>Conversation</header><div className="declared-context-preview__reading">
    <ActivityView sessionId={scene.page.agentSessionId} capability="complete-events" displayState={displayState} items={[]}
      nativeHistoryPage={scene.page} userMessages={messages} />
  </div><footer><textarea aria-label="Reply draft" value={draft} onChange={event => setDraft(event.target.value)} /></footer></main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
