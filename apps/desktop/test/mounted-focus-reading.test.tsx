// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MountedSpaceFocus } from '../src/renderer/src/components/MountedSpaceFocus'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { mountedFocusActivity, mountedFocusProjectKey } from '../src/renderer/src/lib/mounted-focus-presentation'
import { EMPTY_FOCUS_FILTERS } from '../src/renderer/src/lib/focus-filters'
import { mountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import { spaceMountKey } from '../src/shared/space-mount'
import { composerDOM } from './helpers/composer-dom-fixture'
import { spaceMountFixture } from './helpers/space-mount-fixture'
import type { MountedRegionSessionFact } from '../src/renderer/src/lib/space-mount-sessions'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function setup() {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(f.api.watch)
  const resources = await f.api.call('resources', { hostId: b.id }), project = resources.workspaces[0]!
  const registered = await f.api.call('register', { hostId: b.id, registration: { runtimeId: resources.runtimeId, workspaceId: project.workspaceId,
    expectedResource: { hostId: project.hostId, workspacePath: project.path, projectRootPath: project.path } } })
  const target = { hostId: b.id, reference: registered.reference, workspaceId: registered.workspaceId, zoneId: registered.zoneId }
  const regions = [{ regionId: 'agent-region', tabId: 'task', kind: 'agent' as const, agentSessionId: 'original-sid', runId: null, execution: { hostId: 'local', cwd: project.path, runtimeId: b.identity.runtimeId } },
    ...Array.from({ length: 12 }, (_, i) => ({ regionId: `resource-${i}`, tabId: 'resources', kind: i ? 'browser' as const : 'launcher' as const, agentSessionId: null, runId: null, execution: null }))]
  await f.api.call('apply', { hostId: b.id, reference: target.reference, edit: { reference: target.reference, expectedRevision: registered.revision, changes: {
    tabs: [{ tabId: 'task', zoneId: target.zoneId, workspaceId: target.workspaceId, name: 'Repair original request', regionIds: ['agent-region'] },
      { tabId: 'resources', zoneId: target.zoneId, workspaceId: target.workspaceId, name: 'Reference material', regionIds: regions.slice(1).map(r => r.regionId) }], regions
  } } })
  useAppStore.getState().mountSpace(target, false)
  return { f, target, key: spaceMountKey(target.reference) }
}
it('real source membership renders task cards and collapsed exact resource navigation without inventing failure or drafts', async () => {
  const { f, target, key } = await setup(), sessions = useAppStore.getState().sessions
  await dom.render(<MountedSpaceFocus visible query="" />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Repair original request')) })
  expect(dom.container.querySelectorAll('.mounted-space-focus__agents .mounted-space-focus__member')).toHaveLength(1)
  const resources = dom.container.querySelector<HTMLDetailsElement>('.mounted-space-focus__resources')!
  expect(resources.open).toBe(false); expect(resources.textContent).toContain('Resources · 12')
  expect(dom.container.textContent).not.toMatch(/No Agent started|private task draft|Execution unconfirmed/)
  await act(async () => { resources.open = true })
  await dom.click('[data-mounted-focus-region="resource-8"]')
  expect(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, key)?.view?.selection).toMatchObject({ tabId: 'resources', regionId: 'resource-8' })
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect((await f.cores[1]!.store.read())!.graph.regions).toHaveLength(13)
  expect(target.reference.runtimeId).toBe('saved-b-runtime')
})
it('source-qualified project, state, type and text conditions combine without importing local same-SID facts', async () => {
  const { target } = await setup()
  await dom.render(<MountedSpaceFocus visible query="" />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Repair original request')) })
  const selected = { ...EMPTY_FOCUS_FILTERS, projects: [{ id: mountedFocusProjectKey(target), name: 'Source' }], states: ['unknown' as const], types: ['project' as const] }
  await dom.render(<MountedSpaceFocus visible query="Repair original" filters={selected} />)
  expect(dom.container.querySelectorAll('.mounted-space-focus__member')).toHaveLength(1)
  expect(dom.container.querySelector('.mounted-space-focus__resources')).toBeNull()
  await dom.render(<MountedSpaceFocus visible query="" filters={{ ...selected, projects: [{ id: 'another-source', name: 'Other' }] }} />)
  expect(dom.container.querySelector('[data-mounted-focus-source]')).toBeNull()
  await dom.render(<MountedSpaceFocus visible query="" filters={{ ...selected, states: ['working'] }} />)
  expect(dom.container.querySelector('[data-mounted-focus-source]')).toBeNull()
  await dom.render(<MountedSpaceFocus visible query="" filters={{ ...selected, types: ['mote'] }} />)
  expect(dom.container.querySelector('[data-mounted-focus-source]')).toBeNull()
})
it('Provider working observations decay through Core freshness and never fabricate results or process recovery', () => {
  const now = Date.now()
  const fact = { stale: false, current: { state: { status: 'observed', session: { semanticStatus: { state: 'working', source: 'native-hook', observedAt: now } } } } } as MountedRegionSessionFact
  expect(mountedFocusActivity(fact, now)).toMatchObject({ label: 'Working', mark: 'working' })
  expect(mountedFocusActivity(fact, now + 16 * 60_000)).toMatchObject({ label: 'Activity unknown', mark: 'unknown' })
  expect(mountedFocusActivity({ ...fact, stale: true }, now).mark).toBe('unknown')
})

it('one original-source deadline updates both card and facet consumers, and cancels when hidden', async () => {
  const { useMountedFocusClock } = await import('../src/renderer/src/lib/use-mounted-focus-clock')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const now = Date.now(), fact = { stale: false, current: { state: { status: 'observed', session: { semanticStatus: { state: 'working', source: 'native-hook', observedAt: now } } } } } as MountedRegionSessionFact
    const observations = { source: { members: { member: fact.current }, reading: false } } as unknown as Record<string, import('../src/renderer/src/lib/space-mount-sessions').MountedSessionObservation>
    function Consumers({ visible }: { visible: boolean }) {
      const at = useMountedFocusClock(observations, visible), activity = mountedFocusActivity(fact, at)
      return <><span data-card>{activity.label}</span><span data-count>{activity.bucket === 'working' ? 1 : 0}</span></>
    }
    await dom.render(<Consumers visible />)
    expect(dom.container.querySelector('[data-card]')?.textContent).toBe('Working')
    expect(dom.container.querySelector('[data-count]')?.textContent).toBe('1')
    await act(async () => { vi.advanceTimersByTime(16 * 60_000) })
    expect(dom.container.querySelector('[data-card]')?.textContent).toBe('Activity unknown')
    expect(dom.container.querySelector('[data-count]')?.textContent).toBe('0')
    await dom.render(<Consumers visible={false} />)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
