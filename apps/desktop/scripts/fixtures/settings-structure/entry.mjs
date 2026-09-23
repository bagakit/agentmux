import '../settings-workbench/entry.mjs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

// Observe the real App and public Preview owner. No substitute Settings UI or store.
const save = api.config.save
const reveal = api.ui.revealCrashLog
const probe = window.structureProbe = { saves: [], diagnostics: [], events: [] }
api.config.save = async (next, expected) => {
  probe.saves.push({ next: structuredClone(next), expected: structuredClone(expected) })
  return save(next, expected)
}
api.ui.revealCrashLog = async () => {
  const result = await reveal(); probe.diagnostics.push(structuredClone(result)); return result
}
probe.theme = async mode => {
  const current = await api.config.get()
  await save({ ...current, appearance: { ...current.appearance, appAppearance: mode } }, current)
}
probe.config = () => api.config.get()
const keys = ['tabs', 'layouts', 'sessions', 'activeWorkspaceId', 'agentComposerDrafts', 'launcherNameDrafts', 'agentSteerQueues', 'agentSteerInFlight']
probe.beginSurface = () => {
  const state = useAppStore.getState()
  probe.original = Object.fromEntries(keys.map(key => [key, state[key]]))
  probe.originalJSON = JSON.stringify(probe.original)
  return { keys, tabs: Object.keys(state.tabs).length, sessions: state.sessions.length, layouts: Object.keys(state.layouts).length }
}
probe.surface = () => {
  const state = useAppStore.getState()
  return { references: keys.map(key => ({ key, same: state[key] === probe.original[key] })),
    exact: JSON.stringify(Object.fromEntries(keys.map(key => [key, state[key]]))) === probe.originalJSON }
}
const receivers = new WeakMap(); let nextReceiver = 0
for (const type of ['click', 'keydown', 'input']) document.addEventListener(type, event => {
  const node = event.target.closest('button,input,[role=menuitemradio]') || event.target
  if (!receivers.has(node)) receivers.set(node, ++nextReceiver)
  probe.events.push({ type, receiver: receivers.get(node), trusted: event.isTrusted, key: event.key, label: node.getAttribute('aria-label') || node.textContent.trim(), role: node.getAttribute('role'), value: node.value })
}, true)
probe.ready = true

// Explicit Renderer-only count sample, derived from the existing Preview facts.
// Original Sessions remain present and retain identity; no launch/process owner.
let countBaseline
probe.counts = () => {
  const current = useAppStore.getState().sessions
  if (countBaseline) throw new Error('Count sample already active')
  const additions = []
  for (const status of ['working', 'error']) {
    const seed = current.find(session => session.kind === 'agent' && session.status.state === status)
    if (!seed) throw new Error(`Missing actual Preview ${status} seed`)
    const present = current.filter(session => session.kind === 'agent' && session.status.state === status).length
    for (let i = present; i < 12; i++) {
      const session = structuredClone(seed)
      session.id = `structure-count-${status}-${i}`
      session.control = { ...session.control, agentSessionId: session.id,
        run: { ...session.control.run, runId: `structure-count-run-${status}-${i}` } }
      additions.push(session)
    }
  }
  countBaseline = current
  useAppStore.setState({ sessions: [...current, ...additions] })
  return { boundary: 'Constructed Preview Renderer projection only; no Runtime.', originalSessions: current.length,
    additions: additions.length, counts: ['working', 'error'].map(status => ({ status,
      count: useAppStore.getState().sessions.filter(session => session.kind === 'agent' && session.status.state === status).length })) }
}
probe.restoreCounts = () => {
  if (!countBaseline) throw new Error('No count sample to restore')
  useAppStore.setState({ sessions: countBaseline }); countBaseline = undefined
}
