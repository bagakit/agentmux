import { flushSync } from 'react-dom'
import '../agent-region-actions/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { formatRegionAddress } from '../../../src/renderer/src/lib/agent-address'

const workspaceId = useAppStore.getState().activeWorkspaceId!
const tabId = 'region-actions-tab', leftId = 'region-actions-target', rightId = 'region-actions-survivor'
const names = ['Layout coordinator · investigate recovery without losing this original Agent', 'Notes researcher']
const original = (window as any).regionActions
const clipboard: string[] = [], resizes: unknown[] = [], selections: unknown[] = []
const copy = api.ui.writeClipboardText, resize = api.sessions.resize
api.ui.writeClipboardText = async text => { clipboard.push(text); await copy(text) }
api.sessions.resize = async (...args) => { resizes.push(args); return resize(...args) }
for(const type of ['pointerdown','click','keydown'])document.addEventListener(type, event => {
  const item = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null
  const menu = item?.closest<HTMLElement>('.agent-region-menu')
  if (menu && (type !== 'keydown' || (event as KeyboardEvent).key === 'Enter')) selections.push({ type, pointerType: event instanceof PointerEvent ? event.pointerType : null, label: item!.textContent?.trim(), trusted: event.isTrusted,
    owner: menu.dataset.ownerRegionId, open: menu.dataset.state === 'open',
    active: useAppStore.getState().tabs[tabId]?.layout.activeRegionId })
}, true)
function naming() {
  const sessions = useAppStore.getState().sessions
  flushSync(() => useAppStore.setState({sessions: sessions.map((session, index) => index === 1 ? {
    ...session, providerId: sessions[0]!.providerId, executorId: sessions[0]!.executorId, label: sessions[0]!.label
  } : session), agentNames: Object.fromEntries(sessions.map((session, index) => [session.id, names[index]]))}))
}
const probe = {
  names,
  mode(mode: 'terminal' | 'cold' | 'notice') { const generation = original.mode(mode); naming(); return generation },
  observe() { const generation = original.observe(); naming(); return generation },
  focusNeighbor() { flushSync(() => useAppStore.getState().focusRegion(workspaceId, tabId, rightId, 'pointer')) },
  facts() {
    const state = useAppStore.getState()
    return { ...original.facts(), active: state.tabs[tabId]?.layout.activeRegionId, tabs: state.tabs,
      regionAddress: formatRegionAddress(leftId), clipboard: [...clipboard], resizes: [...resizes], selections: [...selections] }
  },
  terminal() {
    const element = document.querySelector(`[data-workbench-region-id="${leftId}"] .xterm`) ?? document.querySelector('.xterm')
    const terminals = (window as any).identityTerminals as Array<{ id: number; terminal: { element: Element | undefined; cols: number; rows: number }; disposed: boolean }>
    const record = terminals.find(record => record.terminal.element === element)
    if (!record || record.disposed) throw new Error('The actual original xterm instance is absent')
    const r = element!.parentElement!.getBoundingClientRect()
    return { id: record.id, cols: record.terminal.cols, rows: record.terminal.rows,
      container: { x: r.x, y: r.y, width: r.width, height: r.height }, resizes: resizes.length }
  }
}
Object.assign(window, { identityMenu: probe })
probe.mode('terminal')
