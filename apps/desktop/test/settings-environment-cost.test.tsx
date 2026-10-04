const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, Profiler, type ProfilerOnRenderCallback } from 'react'
import { expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import * as projects from '../src/renderer/src/lib/workspace-projects'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { AppConfig } from '../src/shared/contracts'

const dom = composerDOM(), save = vi.fn(async () => {}), close = vi.fn()

it('keeps visited Projects directory work independent of unrelated Session publications', async () => {
  const config: AppConfig = { ...composerConfig,
    hosts: [{ id: 'local', kind: 'local', label: 'Local' }, { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'saved.invalid' }],
    workspaces: ['local', 'remote'].flatMap(hostId => Array.from({ length: 128 }, (_, index) => ({
      id: `${hostId}-${index}`, name: `${hostId} Project ${index}`, hostId, path: (_hygiene_fixturePath("owned/") + (hostId) + "/" + (index) + ""), kind: 'folder' as const
    }))) }
  const sessions = Array.from({ length: 64 }, (_, index) => composerSession(`cost-${index}`))
  useAppStore.setState({ config, sessions, hostChecks: {}, checkHost: vi.fn(async () => {}) })
  const aggregate = vi.spyOn(projects, 'projectRailNavigation') // Original implementation is still consumed.
  const commits: { phase: string; actualDuration: number }[] = []
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => { commits.push({ phase, actualDuration }) }
  function View({ active = true }: { active?: boolean }) {
    const current = useAppStore(state => state.config)!
    return <Profiler id="actual-host-settings" onRender={onRender}>
      <HostSettingsPane config={current} active={active} onSave={save} onClose={close} />
    </Profiler>
  }
  const windows: Record<string, unknown> = {}
  function reset() { aggregate.mockClear(); commits.length = 0 }
  function snapshot() { return { commits: [...commits], directoryCalls: aggregate.mock.calls.length,
    directoryRecords: aggregate.mock.calls.reduce((total, [records]) => total + records.length, 0),
    inputSizes: aggregate.mock.calls.map(([records]) => records.length) } }
  async function publishSessions() {
    for (let index = 0; index < 12; index++) await act(async () => useAppStore.setState({
      sessions: sessions.map(session => ({ ...session, updatedAt: index + 2, latestOutputBytes: index + 1 }))
    }))
  }
  await dom.render(<View />)
  await dom.click('[data-host-disclosure="local"] [data-host-panel="projects"]')
  await dom.click('[data-host-disclosure="remote"] [data-host-panel="projects"]')
  expect(dom.container.querySelector('[data-host-projects="local"]')!.hasAttribute('hidden')).toBe(true)
  expect(dom.container.querySelector('[data-host-projects="remote"]')!.hasAttribute('hidden')).toBe(false)
  expect(aggregate.mock.calls.some(([records]) => records.length === 128 && records.every(record => record.hostId === 'remote'))).toBe(true)
  reset(); await publishSessions(); windows.unrelatedSessions = snapshot()

  reset()
  const search = dom.container.querySelector<HTMLInputElement>('[data-host-projects="remote"] input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Project 127')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  windows.relatedQuery = snapshot()
  expect(dom.container.querySelector('[data-host-projects="remote"]')!.textContent).toContain('remote Project 127')
  expect(dom.container.querySelectorAll('[data-host-projects="remote"] [data-project-id]')).toHaveLength(1)

  reset()
  await act(async () => useAppStore.getState().setConfig({ ...config, workspaces: config.workspaces.map(workspace =>
    workspace.id === 'remote-127' ? { ...workspace, name: 'Updated Project 127' } : workspace) }))
  windows.relatedConfig = snapshot()
  expect(dom.container.querySelector('[data-host-projects="remote"]')!.textContent).toContain('Updated Project 127')
  expect(dom.container.querySelector<HTMLInputElement>('[data-host-projects="remote"] input[type="search"]')!.value).toBe('Project 127')

  await dom.render(<View active={false} />)
  reset(); await publishSessions(); windows.inactiveSessions = snapshot()
  if (process.env.SETTINGS_ENV_COST_REPORT) writeFileSync(process.env.SETTINGS_ENV_COST_REPORT,
    JSON.stringify({ fixture: { hosts: 2, registeredFolders: 256, sessions: 64, updates: 12 }, windows }, null, 2))
  const unrelated = windows.unrelatedSessions as ReturnType<typeof snapshot>
  const query = windows.relatedQuery as ReturnType<typeof snapshot>
  const changed = windows.relatedConfig as ReturnType<typeof snapshot>
  const inactive = windows.inactiveSessions as ReturnType<typeof snapshot>
  expect(unrelated.commits.length).toBeGreaterThanOrEqual(12) // Parent really receives the Session updates.
  expect(query.directoryCalls).toBeGreaterThan(0)
  expect(changed.directoryCalls).toBeGreaterThan(0)
  expect(inactive.commits).toHaveLength(0)
  expect(inactive.directoryCalls).toBe(0)
  expect(unrelated.directoryCalls).toBe(0)
})
