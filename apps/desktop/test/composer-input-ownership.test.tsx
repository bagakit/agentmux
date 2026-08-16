// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentComposer } from '../src/renderer/src/components/AgentComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('only the visible Launcher acquires editor focus, including after visibility changes', async () => {
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Launch draft' },
    prewarmTerminal: vi.fn(async () => {}), detectExecutors: vi.fn(async () => {}) })
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    outside.focus()
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
    const editor = dom.container.querySelector<HTMLElement>('.tiptap')!
    expect(editor).not.toBeNull()
    expect(document.activeElement).toBe(outside)
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />)
    await vi.waitFor(() => expect(document.activeElement).toBe(editor))
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
    outside.focus()
    await act(async () => useAppStore.setState({ agentComposerDrafts: { region: 'Updated while hidden' } }))
    expect(document.activeElement).toBe(outside)
    expect(dom.container.querySelector('.tiptap')).toBe(editor)
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />)
    await vi.waitFor(() => expect(document.activeElement).toBe(editor))
  } finally { outside.remove() }
})

it.each(['send', 'queue'] as const)('IME confirmation through the real editor never triggers %s', async (action) => {
  const submit = vi.fn()
  const queue = vi.fn()
  await dom.render(<AgentComposer value="Draft" onChange={() => {}} disabled={false} placeholder="Message"
    onSubmit={submit} {...(action === 'queue' ? { onQueue: queue } : {})} />)
  const editor = dom.container.querySelector<HTMLElement>('.tiptap')!
  expect(editor).not.toBeNull()
  for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...marker })))
  }
  expect(submit).not.toHaveBeenCalled()
  expect(queue).not.toHaveBeenCalled()
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(action === 'send' ? submit : queue).toHaveBeenCalledOnce()
  expect(action === 'send' ? queue : submit).not.toHaveBeenCalled()
})
