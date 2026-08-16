// @vitest-environment happy-dom
import { act } from 'react'
import { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { composerExtensions, draftDocument, documentDraft } from '../src/renderer/src/components/InlineComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, executorDetectionKey } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const path = '/Users/test/.agentmux/pasted/screenshot-1.png'
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const image = { dataUrl }
const thumbnail = () => dom.container.querySelector<HTMLImageElement>('.composer-image img')

it('renders a captured image in the Session draft, enlarges it, restores it and sends the same path', async () => {
  vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(path)
  const read = vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(image)
  const send = vi.spyOn(useAppStore.getState(), 'send').mockResolvedValue(true)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Capture a screen region"]')
  await vi.waitFor(() => expect(thumbnail()?.src).toBe(dataUrl))
  expect(read).toHaveBeenCalledWith(path)
  const draft = `Keep my draft @${path} `
  expect(dom.draft()).toBe(draft)
  await dom.click('.composer-image button')
  expect(document.querySelector<HTMLImageElement>('[role="dialog"] img')?.src).toBe(dataUrl)
  await dom.render(null)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await vi.waitFor(() => expect(thumbnail()?.src).toBe(dataUrl))
  expect(dom.draft()).toBe(draft)
  await dom.click('.composer-send')
  expect(send).toHaveBeenCalledExactlyOnceWith('agent-1', draft, expect.any(Function))
})

it('pasted image bytes resolve to the same preview and durable reference', async () => {
  const save = vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue(path)
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(image)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } })
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(event))
  await vi.waitFor(() => expect(thumbnail()?.src).toBe(dataUrl))
  expect(save).toHaveBeenCalledExactlyOnceWith({ bytes: new Uint8Array([1, 2, 3]), extension: 'png' })
  expect(dom.draft()).toBe(`Keep my draft @${path} `)
})

it('keeps the original image reference readable when preview loading fails', async () => {
  vi.spyOn(api.ui, 'readPastedImage').mockRejectedValue(new Error('Image no longer available'))
  useAppStore.setState({ agentComposerDrafts: { 'agent-1': `before @${path} after` } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(thumbnail()).toBeNull()
  expect(dom.container.querySelector('.composer-image')?.textContent).toBe(`@${path}`)
  expect(dom.draft()).toBe(`before @${path} after`)
})

it('round-trips multiple image nodes, supports deletion/undo, and preserves surrounding text', () => {
  const draft = `before @${path} between\n@/Users/test/.agentmux/pasted/second.jpg after`
  const editor = new Editor({ element: document.createElement('div'), extensions: composerExtensions(), content: draftDocument(draft) })
  try {
    const positions: number[] = []
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'pastedImage') positions.push(pos) })
    expect(positions).toHaveLength(2)
    expect(documentDraft(editor.getJSON())).toBe(draft)
    const copied = editor.state.doc.slice(positions[0]!, positions[0]! + 1).content.toJSON()
    expect(documentDraft({ type: 'doc', content: copied })).toBe(`@${path}`)
    editor.commands.setNodeSelection(positions[0]!)
    editor.commands.deleteSelection()
    expect(documentDraft(editor.getJSON())).toBe(`before  between\n@/Users/test/.agentmux/pasted/second.jpg after`)
    editor.commands.undo()
    expect(documentDraft(editor.getJSON())).toBe(draft)
  } finally { editor.destroy() }
})

it('uses the same image editor for Launcher screenshots', async () => {
  vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(path)
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(image)
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Launch draft' } })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  await dom.click('[aria-label="Capture a screen region"]')
  await vi.waitFor(() => expect(thumbnail()?.src).toBe(dataUrl))
  expect(dom.container.querySelector('.tiptap')?.getAttribute('aria-label')).toBe('Agent prompt')
  expect(dom.draft('region')).toBe(`Launch draft @${path} `)
  const launch = vi.spyOn(useAppStore.getState(), 'launchAgent').mockResolvedValue(undefined)
  await act(async () => useAppStore.setState({ executorDetections: { [executorDetectionKey('local', 'codex')]: { state: 'ready' } } }))
  const enter = (composing: boolean) => new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: composing, bubbles: true, cancelable: true })
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(enter(true)))
  expect(launch).not.toHaveBeenCalled()
  const current = dom.draft('region')
  expect(current).toContain(`@${path}`)
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(enter(false)))
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]?.[1]).toBe(current)
})
