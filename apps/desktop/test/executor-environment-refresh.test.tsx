// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, AgentProviderRegistry } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, executorDetectionKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { executorEnvironmentFixture } from '../../host/test/helpers/executor-environment-fixture'
import type { AppConfig } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {}, clipboard: {}, shell: {}, Menu: {}, webContents: {} }))
const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = [], savedLauncher = useLauncherState.getState()
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  useLauncherState.setState(savedLauncher, true)
  if (errors.length) throw new AggregateError(errors, 'Mounted environment consumers cleanup failed')
})
it('mounted Settings refresh updates the original Launcher through Main and the same long-lived Host', async () => {
  const f = await executorEnvironmentFixture(cleanups)
  const config: AppConfig = { ...composerConfig, hosts: f.configuration.hosts, executors: f.configuration.executors,
    workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => f.client)
  runtime.commit(await runtime.prepare(config)); cleanups.push(() => runtime.dispose())
  const detect = vi.spyOn(api.executors, 'detect').mockImplementation((id, host) => runtime.detect(id, host, config))
  useLauncherState.setState({ sections: { workspace: { agents: 'expanded', terminal: 'collapsed' } }, drafts: {}, executors: {}, persistenceIssue: null })
  useAppStore.setState({ config, providerCatalog: new AgentProviderRegistry().catalog(), activeWorkspaceId: 'workspace',
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    agentComposerDrafts: { region: 'Keep the original unsent work' }, executorDetections: {}, hostExecutorInventories: {}, recoveryCandidates: [],
    warmTerminals: {}, prewarmTerminal: vi.fn(async () => undefined) })
  const status = () => dom.container.querySelector('#executor-settings-codex .check-pill')?.textContent
  await dom.render(<><NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible /><AgentSettingsPane config={config} onSave={async () => { throw Error('Refresh cannot save configuration') }} /></>)
  await act(async () => { await useAppStore.getState().detectExecutors('local') })
  expect(status()).toBe('Not found')
  expect(useAppStore.getState().executorDetections[executorDetectionKey('local', 'codex')]?.state).toBe('missing')
  await f.install()
  const button = dom.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh saved executor availability"]')
  expect(button).not.toBeNull()
  await act(async () => { button!.click(); await useAppStore.getState().detectExecutors('local') })
  expect(status()).toBe('Available')
  expect([...dom.container.querySelectorAll('.agent-catalog .agent-pick:not(.agent-pick--unavailable) strong')].map(node => node.textContent)).toContain('Codex')
  expect(detect.mock.calls.length).toBeGreaterThan(0)
  expect(detect.mock.calls[0]).toEqual(['codex', 'local'])
  expect(useAppStore.getState().config?.executors.codex?.command).toBe(f.command)
  expect(useAppStore.getState().agentComposerDrafts.region).toBe('Keep the original unsent work')
  expect(f.client.runtimeOwnerIdentity()!.ownerInstanceId).toBe(f.originalOwner.ownerInstanceId)
})
