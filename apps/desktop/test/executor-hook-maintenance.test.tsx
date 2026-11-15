// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentCatalogEntry, AgentMuxRpcResult } from '@agentmux/core'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!
const host = { id: 'remote', label: 'Other Host', kind: 'ssh', hostname: 'remote' } as const
const config = { ...composerConfig, hosts: [...composerConfig.hosts, host], workspaces: [{ ...workspace, hostId: host.id }] }
const provider: AgentCatalogEntry = {
  id: 'codex', label: 'Codex from Host', executable: 'codex', expectedProcess: 'codex', promptDelivery: 'positional-argv',
  readySignal: { kind: 'foreground-process', expectedProcess: 'codex' }, hookStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
  resumeStrategy: { kind: 'none' }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: false, replyCorrelation: 'none' }, launchOptions: []
}
const runtimeId = 'original-runtime'
type HookScope = AgentMuxRpcResult<'settings.providers.hooks-list'>['scopes'][number]
const executor = (executorId: string, label = executorId, canInspectLoading = false) => ({ executorId, label, configRevision: `${executorId}-revision`, canInspectLoading })
const first = executor('first', 'First CLI')
const second = executor('second', 'Second CLI')
const other = executor('other', 'Other CLI')
const revision = 'a9b51'.repeat(12) + '6d32'
const declarationPath = `${workspace.path}/hooks.json`
function hookScope(scopeId: string, executors: HookScope['executors'], health: 'issue' | 'current', checkedAt = 1): HookScope {
  const path = scopeId === 'shared' ? declarationPath : `${workspace.path}/other/hooks.json`
  return { providerId: provider.id, scopeId, scopeRevision: `${scopeId}-scope-revision`, paths: [path], kind: 'configuration', executors, health, canUpdate: true,
    inspection: { providerId: provider.id, status: health === 'current' ? 'installed' : 'partial', checkedAt,
      code: health === 'current' ? 'MANAGED_HOOK_CURRENT' : 'MANAGED_HOOK_LEGACY_CARRIER', action: null,
      targets: [{ path, status: health === 'current' ? 'current' : 'partial', expectedRevision: revision,
        ...(health === 'current' ? { observedRevision: revision } : { legacyDeclarations: 3 }) }] },
    update: { status: 'not-requested' } }
}
const shared = hookScope('shared', [first, second], 'issue')
const separate = hookScope('separate', [other], 'current')
const listed = (scopes: HookScope[], workspacePath?: string) => ({ routeHostId: host.id, runtimeId, scopes, ...(workspacePath ? { workspacePath } : {}) })
const confirmed = (scope: HookScope) => ({ routeHostId: host.id, runtimeId, scope })
const target = { hostId: host.id, runtimeId, providerId: provider.id, scopeId: shared.scopeId, scopeRevision: shared.scopeRevision }
const inventory = { routeHostId: host.id, runtimeId, executors: [other, first, second].map(item => ({
  executorId: item.executorId, label: item.label, providerId: provider.id, configRevision: item.configRevision,
  command: 'codex', availability: 'available' as const, source: 'registered' as const
})) }

async function showSettings(field: 'providers' | 'host-executors' = 'providers') {
  vi.spyOn(api.providers, 'forHost').mockResolvedValue({ routeHostId: host.id, runtimeId, observedAt: 1, catalog: [provider] })
  vi.spyOn(api.executors, 'discover').mockResolvedValue(inventory)
  useAppStore.setState({ activeWorkspaceId: workspace.id, hostExecutorInventories: { [host.id]: { state: 'ready', input: host, result: inventory } } })
  await dom.render(<AgentSettingsPane config={config} active onSave={vi.fn()} navigationRequest={{ section: 'agents', field, hostId: host.id }} />)
}
function card(id: string) { return dom.container.querySelector<HTMLElement>(`[data-hook-scope="${id}"]`)! }
async function change(label: string, value: string) {
  const select = dom.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function clickText(parent: ParentNode, label: string) {
  const button = [...parent.querySelectorAll('button')].find(item => item.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}

it('lists the shared native configuration once and applies Check and Update only to its exact scope', async () => {
  const afterWrite = hookScope('shared', [first, second], 'current', 3)
  const list = vi.spyOn(api.providers, 'listHookScopes').mockResolvedValueOnce(listed([separate, shared]))
    .mockResolvedValueOnce(listed([separate, hookScope('shared', [first, second], 'current', 4)]))
  const check = vi.spyOn(api.providers, 'inspectHookScope').mockResolvedValue(confirmed({ ...shared,
    inspection: { ...shared.inspection, checkedAt: 2 } }))
  const update = vi.spyOn(api.providers, 'updateHookScope').mockResolvedValue(confirmed({ ...afterWrite, update: { status: 'updated', receiptId: 'write-receipt' } }))
  await showSettings()
  await dom.click('[aria-label="View Codex from Host Hooks"]')
  expect(list).toHaveBeenCalledExactlyOnceWith({ hostId: host.id, providerId: provider.id })
  expect(dom.container.querySelectorAll('[data-hook-scope]')).toHaveLength(2)
  expect(card('shared').textContent).toContain(declarationPath)
  expect(card('shared').querySelector('[aria-label="Associated Executors"]')?.textContent).toBe('First CLISecond CLI')
  expect(card('shared').querySelector('[aria-label="Hook needs attention"]')).not.toBeNull()
  expect(card('separate').querySelector('[aria-label="Hook needs attention"]')).toBeNull()
  expect(card('shared').querySelector('details')?.hasAttribute('open')).toBe(false)
  expect(card('shared').textContent).toContain('3 older declarations')
  await clickText(card('shared'), 'Check')
  expect(check).toHaveBeenCalledExactlyOnceWith(target)
  expect(update).not.toHaveBeenCalled()
  await clickText(card('shared'), 'Update configuration')
  expect(update).toHaveBeenCalledExactlyOnceWith(target)
  expect(card('shared').querySelector('[aria-label="Hook needs attention"]')).toBeNull()
  expect(card('shared').textContent).toContain('Observed config revision' + revision.slice(0, 12))
  await dom.click('[aria-label="Refresh Hook scopes"]')
  expect(card('shared').textContent).toContain('Managed configuration updated.')
  await dom.click('[aria-label="Back to Providers"]')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('View Codex from Host Hooks')
})

it('opens the linked Executor and returns to the exact shared scope from its detail on the same Host', async () => {
  const list = vi.spyOn(api.providers, 'listHookScopes').mockResolvedValue(listed([separate, shared]))
  await showSettings()
  await dom.click('[aria-label="View Codex from Host Hooks"]')
  await clickText(card('shared'), 'Second CLI')
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Executor Host"]')?.value).toBe(host.id)
  const executorPage = dom.container.querySelector<HTMLElement>('[aria-label="Host executors"]')!
  expect(executorPage.querySelector('.settings-resource-editor strong')?.textContent).toBe(second.label)
  await clickText(executorPage, 'View Hook scope')
  expect(list.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ hostId: host.id, providerId: provider.id }]))
  expect(dom.container.querySelector('[data-hook-scope][data-requested]')).toBe(card('shared'))
  expect(document.activeElement).toBe(card('shared'))
  expect(card('shared').querySelector('[aria-current="true"]')?.textContent).toBe(second.label)
  expect(card('separate').hasAttribute('data-requested')).toBe(false)
})

it('resolves a workspace only when the scope calls for one and keeps the workspace on the exact check', async () => {
  const unresolved: HookScope = { ...shared, scopeId: 'unresolved', kind: 'unresolved', paths: [], canUpdate: false, health: 'unknown',
    inspection: { ...shared.inspection, targets: [], code: 'HOOK_WORKSPACE_REQUIRED', action: 'Choose the execution workspace.' } }
  const list = vi.spyOn(api.providers, 'listHookScopes').mockResolvedValueOnce(listed([unresolved]))
    .mockResolvedValueOnce(listed([shared], workspace.path))
  const check = vi.spyOn(api.providers, 'inspectHookScope').mockResolvedValue({ ...confirmed(shared), workspacePath: workspace.path })
  await showSettings()
  await dom.click('[aria-label="View Codex from Host Hooks"]')
  expect(card('unresolved').querySelector('.provider-hook-scope__actions')).toBeNull()
  await change('Hook workspace', workspace.path)
  expect(list.mock.calls).toEqual([[{ hostId: host.id, providerId: provider.id }], [{ hostId: host.id, providerId: provider.id, workspacePath: workspace.path }]])
  await clickText(card('shared'), 'Check')
  expect(check).toHaveBeenCalledExactlyOnceWith({ ...target, workspacePath: workspace.path })
})

it('keeps native activation on the exact Executor and Workspace without presenting it as a Run receipt', async () => {
  const launch: HookScope = { ...shared, scopeId: 'launch', kind: 'launch-carried', paths: [], canUpdate: false, health: 'unknown',
    executors: [executor(first.executorId, first.label, true), executor(second.executorId, second.label, true)],
    inspection: { ...shared.inspection, targets: [], code: 'HOOK_NATIVE_LOADING_UNCONFIRMED' } }
  vi.spyOn(api.providers, 'listHookScopes').mockResolvedValue(listed([launch]))
  const activate = vi.spyOn(api.providers, 'inspectHookActivation').mockResolvedValue({ routeHostId: host.id, runtimeId,
    executorId: second.executorId, configRevision: second.configRevision, workspacePath: workspace.path, canUpdate: false, health: 'current',
    inspection: { ...launch.inspection, status: 'installed', code: 'NATIVE_HOOK_ACTIVE' }, update: { status: 'not-requested' } })
  await showSettings()
  await dom.click('[aria-label="View Codex from Host Hooks"]')
  expect(card('launch').querySelector('.provider-hook-scope__actions')).toBeNull()
  expect(card('launch').textContent).toContain('Check loading on the original Run.')
  await change('Executor for native activation', second.executorId)
  await change('Native activation workspace', workspace.path)
  await clickText(card('launch'), 'Check native activation')
  expect(activate).toHaveBeenCalledExactlyOnceWith({ hostId: host.id, runtimeId, executorId: second.executorId, configRevision: second.configRevision, workspacePath: workspace.path })
  expect(card('launch').textContent).toContain('Native activation confirmed for this launch configuration.')
  expect(card('launch').textContent).toContain('Each Run has its own loading and delivery state.')
})

it('requires a successful exact readback before retrying an unconfirmed write', async () => {
  vi.spyOn(api.providers, 'listHookScopes').mockResolvedValue(listed([shared]))
  const check = vi.spyOn(api.providers, 'inspectHookScope').mockResolvedValueOnce(confirmed({ ...shared, health: 'unknown',
    inspection: { ...shared.inspection, checkedAt: 3, status: 'error', code: 'MANAGED_HOOK_CHECK_FAILED' } }))
    .mockResolvedValueOnce(confirmed({ ...shared, inspection: { ...shared.inspection, checkedAt: 4 } }))
  const update = vi.spyOn(api.providers, 'updateHookScope').mockResolvedValue(confirmed({ ...shared,
    inspection: { ...shared.inspection, checkedAt: 2 }, update: { status: 'unconfirmed', code: 'HOOK_INSTALL_FAILED' } }))
  await showSettings()
  await dom.click('[aria-label="View Codex from Host Hooks"]')
  await clickText(card('shared'), 'Update configuration')
  const updateButton = [...card('shared').querySelectorAll('button')].find(item => item.textContent === 'Update configuration')!
  expect(updateButton.disabled).toBe(true)
  await clickText(card('shared'), 'Check')
  expect(updateButton.disabled).toBe(true)
  expect(card('shared').textContent).toContain('Update unconfirmed')
  await clickText(card('shared'), 'Check')
  expect(updateButton.disabled).toBe(false)
  expect(check).toHaveBeenCalledTimes(2)
  expect(update).toHaveBeenCalledExactlyOnceWith(target)
})
