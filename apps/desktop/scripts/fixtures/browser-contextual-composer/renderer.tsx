import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { prepareBrowserOperatorAvatar } from '../../../src/renderer/src/lib/browser-operator-avatar'
import '../../../src/renderer/src/styles/index.css'
import './fixture.css'

let startup: (() => void) | undefined, identity: any, theme: any
const errors: string[] = []
const originalReport = useAppStore.getState().reportError
useAppStore.setState({ reportError(error: any, context: any) { errors.push(error?.message ?? String(error)); originalReport(error, context) } })
let setMessage: (value: { message: AgentSessionUserMessage; item?: any; wire?: string }) => void
const copies: string[] = []
function Fixture() {
  const tab = useAppStore(state => state.tabs['contextual-tab']?.regions['contextual-browser-region'])
  const [reading, updateMessage] = useState<{ message: AgentSessionUserMessage; item?: any; wire?: string }>()
  const message = reading?.message
  setMessage = updateMessage
  const warning = useNativeOverlayChrome(document, identity)
  return <WorkbenchDocumentContext.Provider value={{ document, window: identity }}><DesktopClientUiProvider>
    <main className="contextual-fixture"><header><strong>Browser collaboration</strong><span>Private original page · real Agent input</span></header>
      <div className="contextual-fixture__body"><section className="contextual-fixture__browser" data-workbench-region-id="contextual-browser-region">
        {tab?.kind === 'browser' ? <BrowserPane tab={tab} visible /> : null}
      </section><aside className="contextual-fixture__reader" aria-label="Original received opinion">
        <strong>Original Agent input</strong>{message && reading?.item ? <CapturedConversationMessage item={reading.item}
          speaker={speakerOfUserMessage(message)} onCopy={text => { copies.push(text); return true }} /> : message ? <ConversationMessage content={reading?.wire ?? message.contentParts} contentBoundary="wire"
          speaker={speakerOfUserMessage(message)}
          executionHostId="local" messageId={message.id} conversationSessionId={message.agentSessionId}
          onCopy={text => { copies.push(text); return true }} /> : <p>No opinion has been sent.</p>}
      </aside></div>{warning ? <p role="status">{warning}</p> : null}
    </main>
  </DesktopClientUiProvider></WorkbenchDocumentContext.Provider>
}
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { contextualProof: {
  async setup(config: any, session: any, url: string) {
    startup = await useAppStore.getState().initialize()
    identity = await api.ui.workbenchWindows.ready()
    theme = mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
    const browser = await api.browser.create('contextual-browser', url, 'contextual-workspace')
    const region = { ...browser, kind: 'browser' as const, browserId: browser.id, regionId: 'contextual-browser-region', workspaceId: 'contextual-workspace' }
    const tab = createWorkbenchTab('contextual-tab', region)
    useAppStore.setState({ config, sessions: [session], loading: false, toolsOpen: false, tabs: { [tab.id]: tab }, layouts: {},
      agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, error: null })
    root.render(<Fixture />)
    return { browser, identity }
  },
  facts() {
    const state = useAppStore.getState(), tab = state.tabs['contextual-tab']?.regions['contextual-browser-region']
    const stage = document.querySelector('.browser-stage')?.getBoundingClientRect()
    const face = (node: Element) => ({ tag: node.tagName, id: node.id, class: node.className, popover: node.getAttribute('popover'),
      shown: node.hasAttribute('popover') ? node.matches(':popover-open') : null, display: getComputedStyle(node).display,
      visibility: getComputedStyle(node).visibility, box: node.getBoundingClientRect().toJSON() })
    return { browser: tab, sessions: state.sessions, errors: errors.slice(), stage: stage?.toJSON(), copies: copies.slice(),
      overlays: [...document.querySelectorAll('[popover]')].map(node => ({ ...face(node), parent: node.parentElement ? face(node.parentElement) : null })),
      entries: state.agentSteerQueues[state.sessions[0]?.id ?? ''] ?? [], panels: [...document.querySelectorAll('.browser-contextual-composer,.browser-trace-rail')].map(panel => {
        const ancestors = []; for (let node = panel.parentElement; node; node = node.parentElement) ancestors.push(face(node))
        return { document: panel.ownerDocument === document, html: panel.outerHTML, visibility: getComputedStyle(panel).visibility, display: getComputedStyle(panel).display, pointerEvents: getComputedStyle(panel).pointerEvents, text: panel.textContent, box: panel.getBoundingClientRect().toJSON(), ancestors }
      }) }
  },
  reader(message: AgentSessionUserMessage, item?: any) { setMessage({ message, item }) },
  wire(wire: string, message: AgentSessionUserMessage) { setMessage({ message, wire }) },
  appearance(mode: 'dark' | 'light') { updateThemeSelection({ ...useAppStore.getState().config!.appearance, appAppearance: mode }) },
  async rasterPresenceAsset() {
    const style = getComputedStyle(document.documentElement)
    return await prepareBrowserOperatorAvatar({ document, providerId: 'gemini', appearance: { badge: 'shield', tint: '#469b78' },
      colors: { mark: style.getPropertyValue('--text-2').trim(), enamel: style.getPropertyValue('--surface-0').trim(),
        badge: style.getPropertyValue('--text').trim(), badgeBackground: style.getPropertyValue('--surface-1').trim() } })
  },
  async flush(id: string) { return await useAppStore.getState().flushAgentSteerQueue(id) },
  dispose() { root.unmount(); startup?.(); theme?.dispose?.() }
} })
