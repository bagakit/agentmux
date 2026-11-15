// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentCatalogEntry, AgentMuxRpcResult } from '@agentmux/core'
import { ProviderComparisonPane } from '../src/renderer/src/components/settings/ProviderComparisonPane'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const entry = (id: string, label: string, timeline: AgentCatalogEntry['capabilities']['timeline'], permission: AgentCatalogEntry['capabilities']['permission']): AgentCatalogEntry => ({
  id, label, executable: id, expectedProcess: id, promptDelivery: 'positional-argv',
  readySignal: { kind: 'foreground-process', expectedProcess: id },
  hookStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline, permission, providerResume: false, replyCorrelation: 'none' },
  launchOptions: []
})
const catalog = (hostId: string, ...entries: AgentCatalogEntry[]) => ({
  routeHostId: hostId, runtimeId: null, observedAt: 1, catalog: entries
})
const hosts = [
  { id: 'local', label: 'This Mac', kind: 'local' },
  { id: 'remote', label: 'Other Host', kind: 'ssh', hostname: 'remote' }
] as const

function rows() {
  return [...dom.container.querySelectorAll<HTMLTableRowElement>('tbody tr')].map(row => row.dataset.providerId)
}

async function filter(value: string) {
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Filter providers"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('compares the selected Host and hands off the exact Provider even when another Host replies late', async () => {
  let resolveLocal!: (value: AgentMuxRpcResult<'agent.provider.ls'>) => void
  const local = new Promise<AgentMuxRpcResult<'agent.provider.ls'>>(resolve => { resolveLocal = resolve })
  const remote = catalog('remote', entry('grok', 'Remote Grok', 'complete-events', 'observe'), entry('antigravity', 'Antigravity', 'streaming', 'respond'))
  const read = vi.spyOn(api.providers, 'forHost').mockImplementation(hostId => hostId === 'local' ? local : Promise.resolve(remote))
  vi.spyOn(api.executors, 'discover').mockRejectedValue(new Error('Executor inventory unavailable'))
  const open = vi.fn()
  await dom.render(<ProviderComparisonPane active hosts={hosts} onExecutors={open} onHooks={vi.fn()} />)
  const host = dom.container.querySelector<HTMLSelectElement>('[aria-label="Provider Host"]')!
  await act(async () => {
    host.value = 'remote'
    host.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => resolveLocal(catalog('local', entry('grok', 'Local Grok', 'unavailable', 'none'))))
  expect(read.mock.calls).toEqual([['local'], ['remote']])
  expect(rows()).toEqual(['grok', 'antigravity'])
  const first = dom.container.querySelector('tbody tr[data-provider-id="grok"]')!
  const second = dom.container.querySelector('tbody tr[data-provider-id="antigravity"]')!
  expect(first.querySelector('th[scope="row"]')?.textContent).toBe('Remote Grokgrok')
  expect(first.querySelector('[data-semantic-icon="object.activity"]')?.parentElement?.textContent).toBe('Recorded events')
  expect(first.querySelector('[data-semantic-icon="status.permission"]')?.parentElement?.textContent).toBe('Observe')
  expect(second.querySelector('[data-semantic-icon="status.streaming"]')?.parentElement?.textContent).toBe('Live stream')
  expect(second.querySelector('[data-semantic-icon="status.permission-safe"]')?.parentElement?.textContent).toBe('Respond')
  expect(first.textContent).toContain('Unconfirmed')
  expect(first.textContent).not.toContain('0 entries')
  await dom.click('[aria-label="Manage Remote Grok executors"]')
  expect(open).toHaveBeenCalledExactlyOnceWith('remote', 'grok')
})

it('filters names, identifiers and executable commands and preserves an arbitrary comparison selection', async () => {
  const local = catalog('local', entry('codex', 'Codex', 'streaming', 'respond'), entry('grok', 'Grok', 'complete-events', 'observe'),
    { ...entry('antigravity', 'Antigravity', 'complete-events', 'observe'), executable: 'agy' })
  const read = vi.spyOn(api.providers, 'forHost').mockResolvedValue(local)
  await dom.render(<ProviderComparisonPane active hosts={hosts} onExecutors={vi.fn()} onHooks={vi.fn()} />)
  expect(rows()).toEqual(['codex', 'grok', 'antigravity'])
  await dom.click('[aria-label="Select Codex for comparison"]')
  await filter('  AGY ')
  expect(rows()).toEqual(['antigravity'])
  await dom.click('[aria-label="Select Antigravity for comparison"]')
  await filter('unmatched')
  expect(dom.container.querySelector('.provider-comparison__empty')?.textContent).toContain('No providers match')
  await dom.click('[aria-label="Clear provider filter"]')
  expect(rows()).toEqual(['codex', 'grok', 'antigravity'])
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter providers')
  await dom.click('button[aria-pressed="false"]')
  expect(rows()).toEqual(['codex', 'antigravity'])
  const codex = dom.container.querySelector<HTMLInputElement>('[aria-label="Select Codex for comparison"]')!
  await act(async () => { codex.focus(); codex.click() })
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Select Antigravity for comparison')
  await dom.click('[aria-label="Select Antigravity for comparison"]')
  expect(rows()).toEqual(['codex', 'grok', 'antigravity'])
  expect(read).toHaveBeenCalledOnce()
})

it('retains declarations and the original Executor route after a failed same-Host refresh', async () => {
  const local = catalog('local', entry('codex', 'Codex', 'streaming', 'respond'))
  vi.spyOn(api.providers, 'forHost').mockResolvedValueOnce(local).mockRejectedValueOnce(new Error('Connection unavailable'))
  vi.spyOn(api.executors, 'discover').mockResolvedValue({ routeHostId: 'local', runtimeId: 'fixture', executors: [] })
  const open = vi.fn()
  await dom.render(<ProviderComparisonPane active hosts={hosts} onExecutors={open} onHooks={vi.fn()} />)
  await dom.click('[aria-label="Refresh Provider capabilities"]')
  expect(dom.container.querySelector('.provider-comparison__matrix [role="status"]')?.textContent).toContain('Showing the last catalog from this Host.')
  expect(rows()).toEqual(['codex'])
  expect(dom.container.querySelector('tbody tr')?.textContent).toContain('0 entries')
  await dom.click('[aria-label="Manage Codex executors"]')
  expect(open).toHaveBeenCalledExactlyOnceWith('local', 'codex')
})
