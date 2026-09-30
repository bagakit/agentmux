import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import { SettingsPanel, settingsNavGroups } from '../../../src/renderer/src/components/SettingsPanel'
import { SurfaceSwitch } from '../../../src/renderer/src/components/TopRowChrome'
import { WindowUtilityBar } from '../../../src/renderer/src/components/WindowUtilityBar'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { PaneSplitMenu } from '../../../src/renderer/src/components/PaneSplitMenu'
import { BrowserOperationStatus } from '../../../src/renderer/src/components/BrowserOperationSurface'
import { PosturePicker } from '../../../src/renderer/src/components/PosturePicker'
import { ProjectActivity } from '../../../src/renderer/src/components/ProjectActivity'
import * as Menu from '../../../src/renderer/src/components/HoverDropdownMenu'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
const actions: unknown[] = []
const events: { type: string; trusted: boolean; label: string | null; key?: string; value?: string }[] = []
let saves = 0
const save = api.config.save
api.config.save = async (...args) => { saves++; return save(...args) }
useAppStore.setState({ config, mainSurface: 'workbench', sessions: [], sessionSnapshots: {},
  detectExecutors: async () => {}, checkHost: async () => {}, selectSession: id => actions.push({ kind: 'session', id }) })
const facts = () => JSON.stringify({ config: useAppStore.getState().config,
  sessions: useAppStore.getState().sessions, tabs: useAppStore.getState().tabs,
  activeTabId: useAppStore.getState().activeTabId, mainSurface: useAppStore.getState().mainSurface })
const probe = { ready: false, events, actions, facts, initialFacts: facts(), get saves() { return saves },
  categories: (query: string) => settingsNavGroups(query).flatMap(group => group.items.map(item => item.title)) }
Object.assign(window, { __sectionHover: probe })
for (const type of ['pointermove', 'pointerdown', 'click', 'keydown', 'input']) document.addEventListener(type, event => {
  const element = (event.target as Element).closest('button,input,[role=menuitemradio],[role=menuitem],[role=menu]')
  if (element) events.push({ type, trusted: event.isTrusted, label: element.getAttribute('aria-label') || element.textContent,
    ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
    ...(element instanceof HTMLInputElement ? { value: element.value } : {}) })
}, true)

function SettingsFixture() {
  const [open, setOpen] = useState(true)
  return <div className="app-shell app-shell--project-rail-collapsed">
    <main className="main-shell main-shell--merged" aria-label="Controlled empty workbench" />
    {open && <SettingsPanel initialSection="appearance" onClose={() => setOpen(false)} />}
    <footer className="window-status-bar">
      <div className="window-status-bar__surface-switch"><SurfaceSwitch onCloseSettings={() => setOpen(false)} /></div>
      <div className="window-status-bar__right"><span>Controlled status facts</span><SettingsNavigation.Provider value={{ open: () => setOpen(true) }}><WindowUtilityBar settingsOpen={open} onCloseSettings={() => setOpen(false)} /></SettingsNavigation.Provider></div>
    </footer>
  </div>
}

// These are projections with callback sinks, not real Sessions, Run or BrowserView owners.
const sessions: SessionSnapshot[] = ['fixture-one', 'fixture-two'].map(id => ({
  id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/fixture',
  promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, label: id, createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `fixture-${id}` } }
}))
function FeedbackFixture() {
  return <div style={{ position: 'absolute', top: 90, left: 24, display: 'flex', alignItems: 'center', gap: 24 }}>
    <input aria-label="Controlled authored text" defaultValue="draft" style={{ width: 120 }} />
    <PaneSplitMenu regionCount={2} onSplit={direction => actions.push({ kind: 'split', direction })} onArrange={mode => actions.push({ kind: 'arrange', mode })} />
    <BrowserOperationStatus activity={{ operation: null, control: 'human' }} onOpenTimeline={() => actions.push({ kind: 'timeline' })} />
    <PosturePicker control={{ id: 'controlled', label: 'Controlled posture', modes: [
      { id: 'safe', label: 'Safe', tier: 'safe' }, { id: 'caution', label: 'Caution', tier: 'caution' }, { id: 'danger', label: 'Danger', tier: 'danger' }
    ] }} onSet={id => actions.push({ kind: 'posture', id })} />
    <ProjectActivity sessions={sessions} />
    <Menu.Root><Menu.Trigger aria-label="Disabled item proof">Disabled</Menu.Trigger><Menu.Portal><Menu.Content className="tab-context-menu">
      <Menu.Item className="tab-context-menu__item" disabled onSelect={() => actions.push('disabled-item')}>Disabled Item</Menu.Item>
      <Menu.RadioGroup value="other" onValueChange={() => actions.push('disabled-radio')}><Menu.RadioItem className="tab-context-menu__item" value="disabled" disabled>Disabled Radio</Menu.RadioItem></Menu.RadioGroup>
    </Menu.Content></Menu.Portal></Menu.Root>
  </div>
}
createRoot(document.getElementById('root')!).render(<>
  {new URLSearchParams(location.search).get('scenario') === 'feedback' ? <FeedbackFixture /> : <SettingsFixture />}
  <WindowOverlayHost />
</>)
probe.ready = true
