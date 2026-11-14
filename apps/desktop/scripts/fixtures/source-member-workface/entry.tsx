import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { MountedSpaceWorkbench } from '../../../src/renderer/src/components/MountedSpaceWorkbench'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { initialMountedSpaceView } from '../../../src/renderer/src/lib/space-mount-view'
import { splitWorkbenchRegion } from '@agentmux/layout'
import { spaceMountKey } from '../../../src/shared/space-mount'
import '../../../src/renderer/src/styles/index.css'

// Public DTOs captured from the real Source consumer test; external transport is controlled.
// All rendered components, xterm, FitAddon, viewport synchronizer, theme and CSS are production.
mountThemeRuntime(window, { appAppearance: 'dark' })
const sample = await (await fetch('./sample.json')).json(), config = await api.config.get()
const target = sample.target, snapshot = sample.snapshot, region = snapshot.scope.regions[0], tab = snapshot.scope.tabs[0]
const reads: string[] = [], resizes: unknown[] = [], controls: string[] = [], listeners = new Set<(event: any) => void>()
let serial = 0, visible = true
api.spaceMounts.watch = async () => ({ initial: snapshot, dispose() {} })
api.spaceMounts.sessions = async (_input, listener) => {
  setTimeout(() => { for (const frame of sample.metadataFrames) listener(frame) }, 0)
  return { initial: sample.metadata, dispose() {} }
}
api.spaceMounts.member = async (input, listener) => {
  const suffix = ++serial, initial = { id: 'private-member-view-' + suffix, hostId: 'private-member-namespace-' + suffix }
  const session = { ...sample.full, ...initial, label: 'Review checkout plan', control: { ...sample.full.control, hostId: initial.hostId } }
  listeners.add(listener)
  return { initial, dispose() { listeners.delete(listener) }, call: async (method: string, value: any) => {
    reads.push(method)
    if (method === 'read') return session
    if (method === 'attach' || method === 'refreshAttachment') {
      const text = '\u001b[38;5;114mOriginal Source terminal\u001b[0m\r\n\r\nWorkspace: /runtime-d/home\r\nSession and Native Run are retained.\r\n\r\nReview the native terminal for startup and permission questions.\r\n\r\n> ', dataBytes = new TextEncoder().encode(text)
      return { session, attachmentId: value.attachmentId ?? 'private-attachment-' + suffix, currentSize: { cols: 80, rows: 24 }, gap: null, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' },
        replay: [{ type: 'data', runId: input.target.expectedRun.runId, startByte: 0, endByte: dataBytes.length, data: text, dataBytes }] }
    }
    if (method === 'resize') { resizes.push({ ...value, runId: input.target.expectedRun.runId }); return { cols: value.cols, rows: value.rows } }
    if (method === 'detach' || method === 'conversationRelease' || method === 'conversationUnwatch') return
    if (method === 'conversationRead' || method === 'conversationChanges') return sample.page
    if (method === 'conversationWatch') return { hostId: 'local', agentSessionId: input.target.agentSessionId, sourceHostId: 'local', scope: sample.page.scope, coverage: sample.page.coverage, readerId: 'private-conversation-' + suffix }
    controls.push(method); throw Error('Visual proof forbids business input: ' + method)
  } } as never
}
useAppStore.setState({ config: { ...config, hosts: [{ id: target.hostId, kind: 'ssh', label: 'Project device', hostname: 'private-project.example' }] }, sessions: [], loading: false })
useAppStore.getState().mountSpace(target)
const key = spaceMountKey(target.reference)
useAppStore.getState().editSpaceMountDraft(key, tab.tabId, region.regionId, 'Keep this private draft with the original Source Agent.')
let setVisible: (value: boolean) => void = () => {}
function Scene() {
  const [shown, show] = useState(true); setVisible = show
  return <MountedSpaceWorkbench mountKey={key} visible={shown} />
}
const root = createClientUiRoot(document.getElementById('root')!)
flushSync(() => root.render(<Scene />))
Object.assign(window, { memberWorkface: {
  theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
  visible(value: boolean) { visible = value; setVisible(value) },
  failUpdates() { for (const listener of listeners) listener({ type: 'observation-error', error: { code: 'PRIVATE_OBSERVATION_UNAVAILABLE', message: 'Original session updates are temporarily unavailable.' } }) },
  split() {
    const next = { ...region, regionId: 'second-original-region' }
    snapshot.scope.regions.push(next); tab.regionIds.push(next.regionId)
    for (const frame of sample.metadataFrames) if (frame.type === 'observation' && frame.observation.type === 'member') frame.observation.occurrences?.push({ ...frame.observation.occurrences[0], regionId: next.regionId })
    const view = initialMountedSpaceView(snapshot)
    view.tabLayouts[tab.tabId] = splitWorkbenchRegion(view.tabLayouts[tab.tabId], region.regionId, 'right', next.regionId)
    useAppStore.getState().observeSpaceMount(target, { snapshot: { ...snapshot, scope: { ...snapshot.scope } }, reading: false })
    useAppStore.getState().editSpaceMountView(key, view)
  },
  facts: () => ({ reads, resizes, controls, visible, sessions: useAppStore.getState().sessions.length,
    draft: document.querySelector('[role="textbox"]')?.textContent,
    terminal: (globalThis as any).memberWorkfaceTerminals?.filter((terminal: any) => !terminal.disposed).map((terminal: any) => ({ cols: terminal.cols, rows: terminal.rows })) })
} })
