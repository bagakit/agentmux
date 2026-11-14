// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { HostExecutorSettings } from '../src/renderer/src/components/settings/HostExecutorSettings'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('locates the confirmed Hook issue and clears the dot only after an exact successful readback', async () => {
  const host = composerConfig.hosts[0]!, workspace = composerConfig.workspaces[0]!
  const descriptor = { executorId: 'selected', providerId: 'grok', label: 'Selected agent', command: 'grok',
    source: 'registered' as const, configRevision: 'current-revision', availability: 'available' as const }
  const target = { hostId: host.id, runtimeId: 'original-runtime', workspacePath: workspace.path,
    executorId: descriptor.executorId, configRevision: descriptor.configRevision }
  useAppStore.setState({ activeWorkspaceId: workspace.id, hostExecutorInventories: { [host.id]: { state: 'ready', input: host,
    result: { routeHostId: host.id, runtimeId: target.runtimeId, executors: [descriptor] } } } })
  const { hostId, ...resultTarget } = target
  const base = { routeHostId: hostId, ...resultTarget, canUpdate: true }
  const legacy = { providerId: 'grok', checkedAt: 1, status: 'partial' as const, code: 'MANAGED_HOOK_LEGACY_CARRIER',
    action: 'Older callbacks were retained.', targets: [{ path: workspace.path, status: 'partial' as const, legacyDeclarations: 3 }] }
  const maintain = vi.spyOn(api.executors, 'hooks')
    .mockResolvedValueOnce({ ...base, health: 'issue', inspection: legacy, update: { status: 'not-requested' } })
    .mockResolvedValueOnce({ ...base, health: 'issue', inspection: legacy, update: { status: 'unchanged' } })
    .mockResolvedValueOnce({ ...base, health: 'current', inspection: { ...legacy, targets: [], status: 'installed',
      action: null, code: 'MANAGED_HOOK_CURRENT' }, update: { status: 'updated', receiptId: 'write-receipt' } })
  await dom.render(<HostExecutorSettings config={composerConfig} active hookNavigation={{ executorId: 'selected' }} />)
  expect(maintain).toHaveBeenNthCalledWith(1, target, false)
  expect(dom.container.querySelector('[role="img"][aria-label="Hook needs attention"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Managed Hook"]')?.textContent).toContain('3 older declarations')

  async function update() {
    const button = [...dom.container.querySelectorAll('button')].find(item => item.textContent === 'Update Hook')!
    await act(async () => button.click())
  }
  await update()
  expect(maintain).toHaveBeenNthCalledWith(2, target, true)
  expect(dom.container.querySelector('[role="img"][aria-label="Hook needs attention"]')).not.toBeNull()
  await update()
  expect(maintain).toHaveBeenNthCalledWith(3, target, true)
  expect(dom.container.querySelector('[role="img"][aria-label="Hook needs attention"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Managed Hook"]')?.textContent).toContain('Loading by existing Runs is unconfirmed')
})
