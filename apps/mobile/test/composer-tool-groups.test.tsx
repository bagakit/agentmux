// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { activityStatus } from './activity-status-fixture'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.restoreAllMocks()
})
const connection = { state: 'connected' as const, message: 'Original Host' }
const group = (element: HTMLElement) => element.querySelector<HTMLElement>('.composer-tool-group[aria-label="Skills, commands and references"]')!

it('keeps one usable Files beside Commands through all original input modes without replacing the editor or its selection', async () => {
  const f = fixture(), attach = vi.fn()
  const originalSession = f.sessions.get('session-original')
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={connection} platform={createBrowserPlatform()} onAttach={attach} />)
  await paste(view.element, '保留原草稿和选区')
  const original = editor(view.element) as HTMLElement & { editor: Editor }
  await act(async () => { original.editor.commands.setTextSelection({ from: 2, to: 5 }) })
  const selection = original.editor.state.selection.toJSON(), document = original.editor.state.doc
  for (const [index, phase] of ['collapsed', 'current', 'expanded', 'collapsed'].entries()) {
    expect(view.element.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(phase)
    expect(group(view.element), 'Actual reference group').not.toBeNull()
    const files = group(view.element).querySelector<HTMLButtonElement>('[aria-label="Reference files for the Agent to read"]')
    expect(files, 'Original Files is injected into the reference group').not.toBeNull()
    expect(view.element.querySelectorAll('[aria-label="Reference files for the Agent to read"]')).toHaveLength(1)
    expect(group(view.element).contains(button(view.element, 'Choose a command'))).toBe(true)
    await click(files!)
    expect(editor(view.element)).toBe(original)
    expect(original.editor.state.doc).toBe(document)
    expect(original.editor.state.selection.toJSON()).toEqual(selection)
    expect(original.textContent).toBe('保留原草稿和选区')
    if (index < 3) await click(view.element.querySelector('.composer-tool--mode')!)
  }
  expect(attach).toHaveBeenCalledTimes(4)
  expect(f.sessions.get('session-original')).toBe(originalSession)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled(); expect(f.setAgentPosture).not.toHaveBeenCalled()
})

it('keeps IME, queue Enter, immediate Cmd Enter and the independent current-turn interrupt on the original Session and Run', async () => {
  const f = fixture(), originalSession = { ...f.sessions.get('session-original')!, providerId: 'grok',
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  f.sessions.set('session-original', originalSession)
  Object.assign(f.client, { statusAgent: vi.fn(async () => activityStatus(originalSession)) })
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={connection} platform={createBrowserPlatform()} />)
  await paste(view.element, '原目标的排队输入')
  const original = editor(view.element)
  const interrupt = button(view.element, 'Interrupt the current turn')
  expect(interrupt.closest('[aria-label="Current turn"]')).not.toBeNull()
  await click(interrupt)
  expect(f.signalAgent).toHaveBeenCalledExactlyOnceWith('session-original', { runId: 'run-original' }, 'SIGINT')
  expect(original.textContent).toBe('原目标的排队输入')
  for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
    await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...marker })))
  }
  expect(f.submit).not.toHaveBeenCalled()
  const queuedDraft = getDeviceWorkface().snapshot().record.conversation.drafts.find(([key]) => key === JSON.stringify(['draft', 'session-original']))![1]
  await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, execution: 'default', prompt: queuedDraft })
  await paste(view.element, '原目标的立即输入')
  await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })))
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(f.submit.mock.calls[1]![0]).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, execution: 'immediate', admissionIntent: { kind: 'manual-actor' }, prompt: '原目标的立即输入' })
  expect(editor(view.element)).toBe(original)
  expect(f.sessions.get('session-original')).toBe(originalSession)
  expect(f.signalAgent).toHaveBeenCalledTimes(1)
})
