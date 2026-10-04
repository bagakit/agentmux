import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import '../../../src/renderer/src/styles/index.css'

const boundary = window.newProjectBoundary
const setup = await boundary.request('setup')
const preview = await api.config.get()
const config = { ...preview, executors: { codex: preview.executors.codex }, workspaces: setup.config.workspaces }
api.config.get = async () => structuredClone(config)
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
api.demands.list = async () => []
api.spatial.read = () => boundary.request('spatial-read')
api.spatial.commit = input => boundary.request('spatial-commit', input)
api.spatial.retainLabels = values => boundary.request('spatial-retain-labels', values)
api.spatial.onChange = boundary.onSpatialChange
api.ui.requestStorageFlush = () => boundary.request('flush')
api.workspaces.chooseLocalFolder = () => boundary.request('choose-local-folder')
const calls = []
for (const key of ['launchAgent', 'launchTerminal', 'resume', 'stop', 'write', 'submitPrompt']) {
  api.sessions[key] = async () => { calls.push(key); throw new Error('Private workface proof isolates Runtime execution: ' + key) }
}
// Runtime is an isolated leaf. Explicit utility preference avoids artificial Terminal errors.
useAppStore.setState({ prewarmTerminal: async () => {}, projectRailOpen: true, toolsOpen: false })
createRoot(document.getElementById('root')).render(createElement(DesktopClientUiProvider, null, createElement(App)))
let retainedInput
window.newProjectProof = {
  facts() {
    const state = useAppStore.getState(), choice = state.workbenchSpaceSelection
    const regionId = choice?.regionId ?? state.layouts[state.activeWorkspaceId]?.groups.flatMap(group => group.activeTabId ? [state.tabs[group.activeTabId]?.layout.activeRegionId] : []).find(Boolean)
    const body = regionId ? document.querySelector(`[data-workbench-region-id="${CSS.escape(regionId)}"]`)
      : document.querySelector(`[data-workspace-id="${CSS.escape(state.activeWorkspaceId)}"][data-visible="true"] .workspace-workbench`)
    const input = body?.querySelector('[contenteditable="true"]')
    const inspect = node => node ? { className: node.className, opacity: getComputedStyle(node).opacity,
      inert: node.inert, disabled: node.disabled ?? null, readOnly: node.readOnly ?? null,
      contentEditable: node.contentEditable, ariaReadOnly: node.getAttribute('aria-readonly'), ariaBusy: node.getAttribute('aria-busy'),
      animations: node.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime,
        duration: animation.effect?.getComputedTiming().duration, iterations: animation.effect?.getComputedTiming().iterations })) } : null
    const ancestors = []; for (let node = input; node; node = node.parentElement) ancestors.push(inspect(node))
    const notices = [...document.querySelectorAll('.service-window,.workbench-restore-notice')].filter(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden')
    return { loading: state.loading, tabs: Object.keys(state.tabs), topology: projectPersistedWorkbench(state), choice,
      drafts: state.agentComposerDrafts, launcherVisible: Boolean(body?.querySelector('.launch-surface')),
      inputVisible: Boolean(input && input.getBoundingClientRect().height > 0), sameInput: !retainedInput || retainedInput === input,
      calls: [...calls], error: state.error, workbenchSaveWarning: state.workbenchSaveWarning,
      capabilities: { input: inspect(input), ancestors,
        agent: inspect(body?.querySelector('.agent-catalog')), composer: inspect(body?.querySelector('.launcher-composer')),
        footer: inspect(body?.querySelector('.launch-surface__footer')),
        launch: inspect(body?.querySelector('.launcher-launch-button')) },
      notices: notices.map(node => ({ text: node.textContent, fontSize: getComputedStyle(node).fontSize,
        width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }
  },
  async mount() {
    await useAppStore.getState().openProjectFolder()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const state = useAppStore.getState(), workspaceId = state.activeWorkspaceId, layout = state.layouts[workspaceId]
    const firstOpened = this.facts()
    const tabId = state.openLauncher({ workspaceId, tabGroupId: layout.activeGroupId, reveal: true })
    const tab = useAppStore.getState().tabs[tabId]
    if (!tab) throw new Error('Production first Launcher was not created')
    useAppStore.getState().setAgentComposerDraft(tab.layout.activeRegionId, 'Original project draft retained through restart')
    return { firstOpened, explicitDurableLauncherAction: 'openLauncher', tabId, regionId: tab.layout.activeRegionId, groupId: layout.activeGroupId }
  },
  oldUnboundChoice() {
    const regionId = useAppStore.getState().workbenchSpaceSelection?.regionId
    retainedInput = document.querySelector(`[data-workbench-region-id="${CSS.escape(regionId)}"] [contenteditable="true"]`)
    useAppStore.setState(state => ({ workbenchSpaceSelection: { ...state.workbenchSpaceSelection, spaceId: null, zoneId: null } }))
  },
  async ambiguity() {
    // Hold only the private spatial ACK so the explicit observation gap remains visible long
    // enough to inspect; the durable Core origin stays intact and is released before save.
    await boundary.request('hold-spatial-commits')
    useAppStore.setState(state => {
      const choice = state.workbenchSpaceSelection
      const catalog = workbenchSelectionCatalog(state)
      const zone = catalog.tabs.find(tab => tab.tabId === choice.tabId)?.zoneId
      const originalSpace = catalog.bindings.filter(binding => binding.zoneId === zone)
      if (!zone || originalSpace.length !== 1) throw new Error('One original Zone binding required')
      const original = state.spaceZoneBindings[zone] ?? { spaceId: originalSpace[0].spaceId, workspaceId: state.activeWorkspaceId }
      const tab = state.tabs[choice.tabId]
      return { tabs: { ...state.tabs, [tab.id]: { ...tab, space: undefined } },
        workbenchSpaceSelection: { ...choice, spaceId: null, zoneId: null }, spaceZoneBindings: {
        ...state.spaceZoneBindings, [zone]: { ...original, relations: { ...original.relations, [("[\"local\",\"" + _hygiene_fixturePath("private-other-space") + "\"]")]: true } }
      } }
    })
  },
  async save() { await boundary.request('release-spatial-commits'); await prepareRendererUpdate(); await boundary.request('flush'); return this.facts() }
}
