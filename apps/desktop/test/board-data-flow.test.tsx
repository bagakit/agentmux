const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCRATCH_WORKSPACE_ID, type AppConfig, type ScratchTopicSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { workspaces: { listBranches: vi.fn() }, scratch: { listTopics: vi.fn() } }
}))
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { useScratchTopics } from '../src/renderer/src/hooks/useScratchTopics.js'

let root: Root
let container: HTMLDivElement
const initial = useAppStore.getState()
function topic(title: string): ScratchTopicSnapshot {
  return { id: 'view:one', title, summary: '', directoryPath: 'topic--view--one', topicPath: 'topic--view--one/topic.md', collaborators: [] }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useAppStore.setState({
    config: { workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'A', path: _hygiene_fixturePath('A'), kind: 'folder' }] } as AppConfig,
    scratchTopicSnapshots: {}, workspaceFileRevisions: {},
    activeWorkspaceId: 'repo', sessions: []
  })
  vi.mocked(api.scratch.listTopics).mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
})
describe('Topic request lifetime', () => {
  const observed: Array<{ workspaceId: string; titles: string[] | null; error: string | null }> = []
  function Observer({ workspaceId }: { workspaceId: string }) {
    const { topics, error } = useScratchTopics(SCRATCH_WORKSPACE_ID)
    observed.push({ workspaceId, titles: topics?.map((t) => t.title) ?? null, error })
    return createElement('span', null, error ?? topics?.map((t) => t.title).join(','))
  }
  it('never renders old Topics under a new Workspace, even before effects run; ignores late replies', async () => {
    observed.length = 0
    let completeB!: (topics: ScratchTopicSnapshot[]) => void
    vi.mocked(api.scratch.listTopics).mockResolvedValueOnce([topic('A-only')])
      .mockImplementationOnce(() => new Promise((resolve) => { completeB = resolve }))
      .mockResolvedValueOnce([topic('C-only')])
    const select = async (name: string) => { await act(async () => {
      useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', name, path: _hygiene_fixturePath(name), kind: 'folder' }] } })
      root.render(createElement(Observer, { workspaceId: name }))
    }) }
    await select('A')
    expect(container.textContent).toBe('A-only')
    await select('B')
    expect(observed.filter((x) => x.workspaceId === 'B').every((x) => x.titles === null)).toBe(true)
    expect(observed.some((x) => x.workspaceId === 'B')).toBe(true)
    await select('C')
    await act(async () => completeB([topic('stale-B')]))
    expect(container.textContent).toBe('C-only')
  })
})
