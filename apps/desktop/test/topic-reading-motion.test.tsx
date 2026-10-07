// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const dom = composerDOM()
const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', kind: 'folder', path: fixturePath('topic-motion') }
function prepare() {
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, sessions: [], scratchTopicSnapshots: {}, layouts: {}, tabs: {}, spaceZoneBindings: {}, topicCategories: [] })
}
it('uses the real request reading flag, stops both initial loaders after failure, and keeps the original create qualification', async () => {
  prepare()
  let reject!: (error: Error) => void
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(() => new Promise((_resolve, failed) => { reject = failed }))
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={vi.fn()} />)
  const create = dom.container.querySelector<HTMLButtonElement>('[aria-label="Create new Topic"]')!
  expect(create, 'real nonempty Topic header').not.toBeNull()
  expect(create.disabled).toBe(true)
  expect(dom.container.querySelectorAll('[data-icon-animation="spin"]')).toHaveLength(2)
  expect(dom.container.textContent).toContain('Loading Topics')
  await act(async () => { reject(new Error('Original directory unavailable')) })
  expect(useAppStore.getState().scratchTopicSnapshots[workspace.id]?.reading).toBe(false)
  expect(dom.container.querySelectorAll('[data-icon-animation="spin"]')).toHaveLength(0)
  expect(dom.container.textContent).toContain('Topics not confirmed')
  expect(dom.container.textContent).toContain('Original directory unavailable')
  expect(dom.container.textContent).not.toContain('Loading Topics')
  expect(dom.container.querySelector('[aria-label="Create new Topic"]')).toBe(create)
  expect(create.disabled).toBe(true)
})
it('retains the same confirmed Topic and existing actions through an in-flight refresh and its failure', async () => {
  prepare()
  const topic: ScratchTopicSnapshot = { id: 'view:original', title: 'Original Topic', summary: '', directoryPath: workspace.path + '/topic--original', topicPath: workspace.path + '/topic--original/topic.md', collaborators: [] }
  const list = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={vi.fn()} />)
  const row = dom.container.querySelector('[data-topic-id="topic:original"]') ?? dom.container.querySelector('.workspace-topic-item')
  expect(row, 'real retained Topic row').not.toBeNull()
  let reject!: (error: Error) => void
  list.mockImplementation(() => new Promise((_resolve, failed) => { reject = failed }))
  let pending!: Promise<void>
  await act(async () => { pending = useAppStore.getState().refreshScratchTopics(workspace.id, true) })
  expect(dom.container.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  expect(dom.container.querySelector('.workspace-topic-item')).toBe(row)
  await act(async () => { reject(new Error('Refresh observation failed')); await pending })
  expect(dom.container.querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(dom.container.querySelector('.workspace-topic-item')).toBe(row)
  expect(dom.container.textContent).toContain('Original Topic')
  expect(dom.container.textContent).toContain('Refresh observation failed')
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Create new Topic"]')!.disabled).toBe(false)
})
it('keeps the original create callback and real create waiting feedback after directory reading has finished', async () => {
  prepare()
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  let reject!: (error: Error) => void
  const create = vi.fn<ReturnType<typeof useAppStore.getState>['createScratchTopic']>().mockImplementation(() => new Promise((_resolve, failed) => { reject = failed }))
  useAppStore.setState({ createScratchTopic: create })
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={vi.fn()} />)
  const button = dom.container.querySelector<HTMLButtonElement>('[aria-label="Create new Topic"]')!
  expect(button.disabled).toBe(false)
  expect(dom.container.querySelector('[data-icon-animation="spin"]')).toBeNull()
  await act(async () => button.click())
  expect(create).toHaveBeenCalledExactlyOnceWith(undefined, undefined, undefined)
  expect(button.disabled).toBe(true)
  expect(dom.container.querySelectorAll('[data-icon-animation="spin"]')).toHaveLength(2)
  await act(async () => reject(new Error('Original create failed')))
  expect(button.disabled).toBe(false)
  expect(dom.container.querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(dom.container.textContent).toContain('Original create failed')
})
