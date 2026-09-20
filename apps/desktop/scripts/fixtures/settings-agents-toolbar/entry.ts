import '../settings-search-refinement/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

// Observers delegate to the original Preview API. Its Store, editor, config publication,
// and actions remain the product owners; these observations make no native CLI claim.
const checks: unknown[] = [], saves: unknown[] = [], events: unknown[] = []
const detect = api.executors.detect, save = api.config.save
api.executors.detect = async (executorId, hostId) => {
  const result = await detect(executorId, hostId)
  checks.push({ executorId, hostId, input: structuredClone(result.input) })
  return result
}
api.config.save = async (next, expected) => {
  saves.push({ next: structuredClone(next), expected: structuredClone(expected) })
  return save(next, expected)
}
api.config.onChange(config => useAppStore.setState({ config }))
for (const type of ['click', 'keydown', 'input', 'change']) document.addEventListener(type, event => {
  const element = (event.target as Element).closest('button,input,select')
  if (!element) return
  events.push({ type, trusted: event.isTrusted, label: element.getAttribute('aria-label') ||
    (element instanceof HTMLSelectElement ? element.closest('label')?.querySelector('span')?.textContent : element.textContent),
    ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
    ...(element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? { value: element.value } : {}) })
}, true)
const baseline = structuredClone(useAppStore.getState().config!)
Object.assign(window, { __agentsToolbar: {
  ready: true, baseline, checks, saves, events,
  saved: () => structuredClone(useAppStore.getState().config),
  preserved: () => structuredClone({ sessions: useAppStore.getState().sessions,
    tabs: useAppStore.getState().tabs, drafts: useAppStore.getState().agentComposerDrafts }),
  async hostLabel(mode: 'short' | 'long') {
    const current = await api.config.get()
    await api.config.save({ ...current, hosts: current.hosts.map(host => host.id === 'local' ? {
      ...host, label: mode === 'long' ? 'Primary development machine' : baseline.hosts.find(item => item.id === 'local')!.label
    } : host) }, current)
  }
} })
