// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MoteQuickMode } from '../src/renderer/src/components/MoteQuickMode'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { serializeMoteQuickMode } from '../src/shared/mote-quick-mode'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, scratchWorkspace } from './fixtures/mote-workface'

const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'actual-target.invalid' }
const workspace = { ...scratchWorkspace, hostId: host.id }
const topic = { ...moteTopics[0]!, quickMode: { status: 'saved' as const, defaults: { executorId: 'fixture' }, version: 'same-original-choice' } }
let app: MoteAppFixture, container: HTMLDivElement, root: Root
beforeEach(() => {
  app = createMoteApp(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, hosts: [...config.hosts, host] }, hostExecutorInventories: { remote: { state: 'ready', input: host,
    result: { runtimeId: 'remote-runtime', routeHostId: host.id, executors: [{ executorId: 'fixture', label: 'Remote colleague', providerId: 'codex', command: 'unused', source: 'registered', configRevision: 'original-remote', availability: 'available' }] } } } })
  const text = serializeMoteQuickMode('', topic.quickMode.defaults)
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: topic.directoryPath, path: topic.directoryPath.slice(workspace.path.length + 1) + '/' + params.path }, result: { status: 'read', document: { path: topic.directoryPath.slice(workspace.path.length + 1) + '/' + params.path, content: text, revision: 'sha256:' + '1'.repeat(64) } } }))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await app.dispose() })
async function mount() { await act(async () => root.render(<MoteQuickMode scope={{ workspace, topic, rootPath: topic.directoryPath.slice(workspace.path.length + 1) }} active onOpenPath={async () => false} />)); await settleMoteApp() }
it('Profile and edit use the exact Host inventory when a local Executor has the same ID', async () => {
  await mount()
  expect(container.querySelector('.mote-quick-mode__row strong')?.textContent).toBe('Remote colleague')
  await moteClick(container.querySelector<HTMLElement>('[aria-label="Edit quick mode"]')!)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Executor for new chat"]')!
  expect(trigger.dataset.value).toBe('fixture'); expect(trigger.textContent).toContain('Remote colleague')
  expect(trigger.title).toContain('Codex · Available'); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
it('a stale remote inventory preserves the raw saved ID instead of borrowing a local or former Host label', async () => {
  const inventory = useAppStore.getState().hostExecutorInventories.remote!
  useAppStore.setState({ hostExecutorInventories: { remote: { ...inventory, input: { ...host, hostname: 'previous-target.invalid' } } } })
  await mount()
  expect(container.querySelector('.mote-quick-mode__row strong')?.textContent).toBe('fixture')
  await moteClick(container.querySelector<HTMLElement>('[aria-label="Edit quick mode"]')!)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Executor for new chat"]')!
  expect(trigger.dataset.value).toBe('fixture'); expect(trigger.title).toContain('Configuration unavailable')
  expect(trigger.textContent).not.toContain('Remote colleague'); expect(app.launch).not.toHaveBeenCalled()
})
