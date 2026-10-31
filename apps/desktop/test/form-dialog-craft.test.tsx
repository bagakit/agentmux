// @vitest-environment happy-dom
import { act, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { ProjectGroupDialog } from '../src/renderer/src/components/ProjectGroupDialog'
import { HostFolderDialog } from '../src/renderer/src/components/HostFolderDialog'
import { TopicCategoryDialog } from '../src/renderer/src/components/TopicCategoryDialog'
import { MoteRenameDialog } from '../src/renderer/src/components/MoteRenameDialog'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const dom = composerDOM()
const category = { categoryId: 'original-category', title: 'Research', revision: 'original-revision', hostId: 'local', spaceId: 'category-space', directoryPath: fixturePath('category') }
const workspace = composerConfig.workspaces[0]!
const topic = { id: 'original-topic', title: 'Original Mote', directoryPath: 'topic-original', topicPath: 'topic-original/topic.md', identityDirectoryPath: workspace.path, physicalDirectoryPath: workspace.path, summary: '', collaborators: [] }
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  expect(node, label).toBeDefined(); return node!
}
async function click(label: string) { await act(async () => button(label).click()) }
async function input(value: string) {
  await act(async () => { const node = document.querySelector<HTMLInputElement>('.confirmation-dialog input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true })) })
}
function group(onClose = () => {}) { return <ProjectGroupDialog projects={[]} related={new Map()} observations={new Map()} onClose={onClose} /> }

it.each(['group', 'folder', 'category', 'mote'])('%s uses one primary native submit, a secondary cancel and shared field skin', async kind => {
  await dom.render(kind === 'group' ? group() : kind === 'folder' ? <HostFolderDialog hostId="local" label="Original Host" onClose={() => {}} />
    : kind === 'category' ? <TopicCategoryDialog target={category} onClose={() => {}} /> : <MoteRenameDialog target={{ topic, workspace }} onClose={() => {}} />)
  const primary = document.querySelectorAll<HTMLButtonElement>('.confirmation-dialog .primary-button')
  expect(primary).toHaveLength(1); expect(primary[0]!.type).toBe('submit')
  expect(button('Cancel').type).toBe('button'); expect(button('Cancel').classList.contains('small-button')).toBe(true)
  expect(document.querySelectorAll('.confirmation-dialog__field > .ui-input')).toHaveLength(1)
  expect(document.querySelector('.confirmation-dialog__heading > button[aria-label^="Close"]')).not.toBeNull()
})

it('the original group retries its unconfirmed save even when a later error uses applied-looking display text', async () => {
  const close = vi.fn(), save = vi.spyOn(useAppStore.getState(), 'saveProjectGroup')
    .mockResolvedValueOnce({ layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null })
    .mockRejectedValueOnce(new Error('Group applied. The next save failed.'))
    .mockResolvedValueOnce({ layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null })
  await dom.render(group(close)); await input('Retained group'); await click('Create group')
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('Saving is unconfirmed'))
  await click('Retry saving'); await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('next save failed'))
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Saving is unconfirmed')
  expect(document.querySelector<HTMLInputElement>('.confirmation-dialog input')?.value).toBe('Retained group')
  await click('Retry saving'); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledTimes(3)
  expect(new Set(save.mock.calls.map(([request]) => request.groupId)).size).toBe(1)
})

it('a group failure whose copy starts with applied wording does not become an unconfirmed receipt', async () => {
  vi.spyOn(useAppStore.getState(), 'saveProjectGroup').mockRejectedValue(new Error('Group applied. This is still a thrown failure.'))
  await dom.render(group()); await input('Original'); await click('Create group')
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
  expect(document.querySelector('[role="status"]')).toBeNull(); expect(button('Create group')).toBeDefined()
})

it.each(['group', 'category'])('%s retains IME ownership for both native composing and legacy Enter markers', async kind => {
  await dom.render(kind === 'group' ? group() : <TopicCategoryDialog target={category} onClose={() => {}} />)
  const node = document.querySelector<HTMLInputElement>('.confirmation-dialog input')!
  for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...marker })
    await act(async () => node.dispatchEvent(event)); expect(event.defaultPrevented).toBe(true)
  }
})

it.each(['group', 'folder'])('%s returns focus to the opening control after Cancel', async kind => {
  function Scene() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Original opener</button>{open ? kind === 'group'
    ? group(() => setOpen(false)) : <HostFolderDialog hostId="local" label="Original Host" onClose={() => setOpen(false)} /> : null}</> }
  await dom.render(<Scene />)
  button('Original opener').focus(); await click('Original opener')
  await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'))
  await click('Cancel'); await vi.waitFor(() => expect(document.activeElement).toBe(button('Original opener')))
})

it('Category rename keeps the missing-revision failure and the draft without calling another owner', async () => {
  const call = vi.spyOn(api.topics, 'call'), close = vi.fn()
  await dom.render(<TopicCategoryDialog target={{ ...category, revision: undefined }} onClose={close} />)
  await input('Retained Category name'); await click('Save category')
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Read the original Category'))
  expect(call).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('.confirmation-dialog input')?.value).toBe('Retained Category name')
})

it('Mote rename keeps a replacement target open when the old save settles', async () => {
  let resolve!: () => void
  const save = vi.spyOn(useAppStore.getState(), 'renameScratchTopic').mockImplementation(() => new Promise<void>(yes => { resolve = yes }))
  const close = vi.fn()
  await dom.render(<MoteRenameDialog target={{ topic, workspace }} onClose={close} />); await input('First renamed'); await click('Save name')
  expect(save).toHaveBeenCalledWith(topic.id, 'First renamed', workspace.id)
  await dom.render(<MoteRenameDialog target={{ topic: { ...topic, id: 'replacement-topic', title: 'Replacement Mote' }, workspace }} onClose={close} />)
  await act(async () => resolve()); expect(close).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('.confirmation-dialog input')?.value).toBe('Replacement Mote')
  expect(button('Save name').disabled).toBe(false)
})
