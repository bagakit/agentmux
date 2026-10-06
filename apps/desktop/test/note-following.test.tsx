// @vitest-environment happy-dom
import { act } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxNotebookStore } from '../../../packages/core/src/notebook-store'
import { NotebookPageDetails } from '../src/renderer/src/components/NotebookPageDetails'
import { api } from '../src/renderer/src/lib/api'
import { observeNotebookLibrary, refreshNotebookLibrary, useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), self = { kind: 'user', id: 'trusted-ui-user' } as const
const agent = { kind: 'agent', id: 'exact-agent-session-with-an-unusually-long-stable-identity' } as const
let owner: AgentMuxNotebookStore, directory: string, stop: () => void
function Page() { const page = useNotebookLibrary(state => state.state?.pages.original); return page ? <NotebookPageDetails page={page} /> : null }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amx-note-follow-'))
  owner = new AgentMuxNotebookStore(join(directory, 'notebooks.json'))
  await owner.apply({ expectedRevision: 0, operationId: 'register', change: { kind: 'register', noteId: 'original', title: 'A durable finding', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'original.note.md' } } }, self)
  await owner.apply({ expectedRevision: 1, operationId: 'agent-follow', change: { kind: 'follow', noteId: 'original' } }, agent)
  vi.spyOn(api.notebooks, 'actor').mockResolvedValue(self)
  vi.spyOn(api.notebooks, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.notebooks, 'apply').mockImplementation(input => owner.apply(input, self))
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  useNotebookLibrary.setState({ state: await owner.read(), issue: null })
  stop = observeNotebookLibrary()
})
afterEach(async () => { stop(); await dom.render(null); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); useNotebookLibrary.setState({ state: null, issue: null }) })

it('uses the original Notebook owner to follow and unfollow, preserves other identities, and restores the saved list after remount', async () => {
  const original = useAppStore.getState(), run = original.sessions[0]
  useAppStore.setState({ agentNames: { [agent.id]: 'Research assistant' } })
  await dom.render(<Page />)
  await dom.click('[aria-label="Page followers"]')
  expect(dom.container.querySelector('[aria-label="Note followers"]')?.textContent).toContain('Agent · Research assistant')
  expect(dom.container.querySelector('[aria-label="Note followers"]')?.textContent).toContain(agent.id)
  const button = dom.container.querySelector<HTMLButtonElement>('[aria-label="Follow page"]')!
  await act(async () => { button.focus(); button.click() })
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Unfollow page"]')?.getAttribute('aria-pressed')).toBe('true'))
  expect(document.activeElement).toBe(button)
  const followed = await owner.read()
  expect(followed.pages.original!.followers?.map(f => f.actor)).toEqual([agent, self])
  expect(dom.container.querySelector('[aria-label="Note followers"]')?.textContent).toContain('You')
  expect(dom.container.querySelector('[aria-label="Note followers"]')?.textContent).not.toContain('user ·')
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)?.[0].change).toEqual({ kind: 'follow', noteId: 'original' })
  await dom.render(null)
  const reopened = new AgentMuxNotebookStore(owner.path)
  await act(async () => { useNotebookLibrary.setState({ state: await reopened.read(), issue: null }) })
  await dom.render(<Page />)
  await dom.click('[aria-label="Page followers"]')
  expect(dom.container.querySelector('[aria-label="Note followers"]')?.textContent).toContain('You')
  await dom.click('[aria-label="Unfollow page"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Follow page"]')?.getAttribute('aria-pressed')).toBe('false'))
  expect((await owner.read()).pages.original!.followers).toEqual(followed.pages.original!.followers!.filter(f => f.actor.kind === 'agent'))
  expect(useAppStore.getState().sessions[0]).toBe(run)
  expect(useAppStore.getState().tabs).toBe(original.tabs)
})

it('retains the exact follow operation after a lost receipt while unrelated metadata remains editable', async () => {
  const write = vi.mocked(api.notebooks.apply).getMockImplementation()!
  vi.mocked(api.notebooks.apply).mockImplementationOnce(async input => { await write(input); throw new Error('Follow reply lost') })
  await dom.render(<Page />)
  await dom.click('[aria-label="Follow page"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Follow reply lost'))
  const input = vi.mocked(api.notebooks.apply).mock.calls[0]![0]
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Page title"]')?.disabled).toBe(false)
  await dom.click('.notebook-change-issue button')
  await vi.waitFor(() => expect(dom.container.querySelector('.notebook-change-issue')).toBeNull())
  expect(vi.mocked(api.notebooks.apply).mock.calls.at(-1)?.[0].operationId).toBe(input.operationId)
  expect((await owner.read()).pages.original!.followers?.map(f => f.actor)).toEqual([agent, self])
  expect((await owner.read()).trail.filter(event => event.action === 'followed')).toHaveLength(2)
})

it('keeps unknown self identity explicit and retains the available follow path and exact unavailable Agent identity', async () => {
  vi.mocked(api.notebooks.actor).mockRejectedValue(new Error('Identity observation unavailable'))
  await dom.render(<Page />)
  await dom.click('[aria-label="Page followers"]')
  expect(dom.container.textContent).toContain('Your follow state is unknown.')
  expect(dom.container.querySelector('[aria-label="Follow page"]')?.hasAttribute('aria-pressed')).toBe(false)
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Follow page"]')!.disabled).toBe(false)
  expect(dom.container.querySelector('[aria-label="Note followers"]')?.textContent).toContain(`Agent · ${agent.id}`)
  await dom.click('[aria-label="Follow page"]')
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.followers?.map(f => f.actor)).toEqual([agent, self]))
  const unfollow = [...dom.container.querySelectorAll<HTMLButtonElement>('.notebook-follow-recovery button')].find(button => button.textContent === 'Unfollow myself')!
  await vi.waitFor(() => expect(unfollow.disabled).toBe(false))
  await act(async () => unfollow.click())
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.followers?.map(f => f.actor)).toEqual([agent]))
  expect(dom.container.textContent).toContain('Your follow state is unknown.')
  await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Follow page"]')!.disabled).toBe(false))
  await dom.click('[aria-label="Follow page"]')
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.followers?.map(f => f.actor)).toEqual([agent, self]))
  vi.mocked(api.notebooks.actor).mockResolvedValue(self)
  await dom.click('.notebook-followers .notebook-change-issue button')
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Unfollow page"]')?.getAttribute('aria-pressed')).toBe('true'))
  expect(dom.container.textContent).not.toContain('Your follow state is unknown.')
  await act(async () => { await refreshNotebookLibrary() })
})

it('keeps self-unfollow available while the identity observation is still pending', async () => {
  await owner.apply({ expectedRevision: 2, operationId: 'existing-self-follow', change: { kind: 'follow', noteId: 'original' } }, self)
  useNotebookLibrary.setState({ state: await owner.read(), issue: null })
  vi.mocked(api.notebooks.actor).mockReturnValue(new Promise(() => {}))
  await dom.render(<Page />)
  await dom.click('[aria-label="Page followers"]')
  expect(dom.container.textContent).toContain('Confirming your identity.')
  const unfollow = [...dom.container.querySelectorAll<HTMLButtonElement>('.notebook-follow-recovery button')].find(button => button.textContent === 'Unfollow myself')!
  expect(unfollow.disabled).toBe(false)
  await act(async () => unfollow.click())
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.followers?.map(f => f.actor)).toEqual([agent]))
  expect(dom.container.textContent).toContain('Your follow state is unknown.')
})
