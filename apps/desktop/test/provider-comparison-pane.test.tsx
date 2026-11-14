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

it('compares the selected Host and hands off the exact Provider even when another Host replies late', async () => {
  let resolveLocal!: (value: AgentMuxRpcResult<'agent.provider.ls'>) => void
  const local = new Promise<AgentMuxRpcResult<'agent.provider.ls'>>(resolve => { resolveLocal = resolve })
  const remote = catalog('remote', entry('grok', 'Remote Grok', 'complete-events', 'observe'), entry('antigravity', 'Antigravity', 'streaming', 'respond'))
  const read = vi.spyOn(api.providers, 'forHost').mockImplementation(hostId => hostId === 'local' ? local : Promise.resolve(remote))
  const open = vi.fn()
  await dom.render(<ProviderComparisonPane active hosts={[
    { id: 'local', label: 'This Mac', kind: 'local' },
    { id: 'remote', label: 'Other Host', kind: 'ssh', hostname: 'remote' }
  ]} onExecutors={open} />)
  const host = dom.container.querySelector<HTMLSelectElement>('[aria-label="Provider Host"]')!
  await act(async () => {
    host.value = 'remote'
    host.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => resolveLocal(catalog('local', entry('grok', 'Local Grok', 'unavailable', 'none'))))
  expect(read.mock.calls).toEqual([['local'], ['remote']])
  const table = dom.container.querySelector('table')
  expect(table).not.toBeNull()
  expect(table!.textContent).toContain('Recorded events')
  expect(table!.textContent).toContain('Live stream')
  expect(table!.textContent).toContain('Observe')
  expect(table!.textContent).toContain('Respond')
  expect(table!.textContent).not.toContain('Local Grok')
  await act(async () => table!.querySelector<HTMLButtonElement>('[aria-label="View Remote Grok executors"]')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('remote', 'grok')
  const option = dom.container.querySelector<HTMLButtonElement>('[role="option"][data-resource-row="antigravity"]')!
  await act(async () => option.click())
  expect(table!.textContent).toContain('Antigravity')
  expect(table!.textContent).not.toContain('Remote Grok')
  await act(async () => table!.querySelector<HTMLButtonElement>('[aria-label="Remove Antigravity from comparison"]')!.click())
  expect(table!.textContent).toContain('Remote Grok')
})
