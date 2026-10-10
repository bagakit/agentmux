// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationLandmarkStore } from '@agentmux/core'
import type { ConversationItemRef } from '@agentmux/core/conversation'
import { ConversationLandmarkList, SaveConversationLandmark } from '../src/renderer/src/components/ConversationLandmarks'
import { createConversationLandmarksApi } from '../src/renderer/src/lib/conversation-landmarks-api'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

async function until(assertion: () => void | Promise<void>) { let failure: unknown; for (let attempt = 0; attempt < 150; attempt++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { await assertion(); return } catch (error) { failure = error } } throw failure }

it('routes saved reading points to the original workface document and reconciles the same unknown operation before renaming or removing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const directory = await mkdtemp(join(tmpdir(), 'amx-window-points-'))
  const store = new ConversationLandmarkStore(join(directory, 'points.json'))
  const scope = { hostId: 'original-host', agentSessionId: 'original-session' }
  const reference: ConversationItemRef = { ...scope, source: { kind: 'native', providerId: 'original-provider', nativeSessionId: 'original-native-session', recordId: 'original-record' } }
  const actor = { kind: 'user', id: 'original-user' } as const
  const bridge = createConversationLandmarksApi({ list: value => store.list(value), apply: value => store.apply(value, actor) })
  let unavailable = true
  const list = vi.spyOn(api.landmarks, 'list').mockImplementation(bridge.list)
  const apply = vi.spyOn(api.landmarks, 'apply').mockImplementation(async input => {
    const page = await bridge.apply(input)
    if (unavailable) { unavailable = false; throw new Error('Original reply observation unavailable') }
    return page
  })
  useAppStore.setState({ conversationLandmarkIntents: {}, workbenchSaveWarning: null })
  const host = document.createElement('div'), frame = document.createElement('iframe')
  document.body.append(host, frame)
  const child = frame.contentDocument!, root = createRoot(host)
  const scene = <><SaveConversationLandmark reference={reference}/><ConversationLandmarkList reference={scope} reveal={async () => ({ kind: 'unavailable', message: 'The original record is not loaded.' })} active/></>
  const render = async (ownerDocument: Document) => { await act(async () => root.render(<WorkbenchDocumentContext.Provider value={{ document: ownerDocument, window: null }}>{scene}</WorkbenchDocumentContext.Provider>)) }
  const click = async (node: Element | null) => { expect(node).not.toBeNull(); await act(async () => (node as HTMLElement).click()) }
  const button = (owner: Document, text: string) => [...owner.querySelectorAll('button')].find(node => node.textContent === text)!
  const input = (owner: Document) => owner.querySelector<HTMLInputElement>('.conversation-landmark input')!
  const edit = async (owner: Document, value: string) => { await act(async () => { const field = input(owner); Object.getOwnPropertyDescriptor(field.ownerDocument.defaultView!.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
  const submit = async (owner: Document) => { await act(async () => owner.querySelector('.conversation-landmark form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
  try {
    await render(document); expect(list).not.toHaveBeenCalled()
    await click(host.querySelector('[aria-label="Name reading point"]')); await edit(document, 'Original named point'); await submit(document)
    await until(() => expect(document.body.textContent).toContain('Original reply observation unavailable'))
    const original = apply.mock.calls[0]![0]
    expect((await store.list(scope)).points[0]?.reference).toEqual(reference)
    expect(input(document).readOnly).toBe(true)
    child.body.append(child.adoptNode(host)); await render(child)
    await until(() => expect(child.querySelector('.conversation-landmark input')).not.toBeNull())
    expect(document.querySelector('.conversation-landmark')).toBeNull()
    expect(input(child).value).toBe('Original named point'); expect(input(child).readOnly).toBe(true)
    expect(child.querySelector('.conversation-landmark__operation')?.textContent).toBe(original.operationId)
    expect(apply).toHaveBeenCalledTimes(1)
    await click(button(child, 'Check original save'))
    await until(() => expect(child.body.textContent).toContain('Saved. Return from Reading points.'))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(list.mock.calls.some(([input]) => input.operationId === original.operationId)).toBe(true)
    await click(child.querySelector('[aria-label="Close Name reading point"]'))
    await click(host.querySelector('[aria-label="Reading points"]'))
    await until(() => expect(child.querySelector('[aria-label="Rename Original named point"]')).not.toBeNull())
    await click(child.querySelector('[aria-label="Rename Original named point"]')); await edit(child, 'Renamed original point'); await submit(child)
    await until(() => expect(child.querySelector('[aria-label="Remove Renamed original point"]')).not.toBeNull())
    await click(child.querySelector('[aria-label="Remove Renamed original point"]'))
    await until(async () => expect((await store.list(scope)).points).toHaveLength(0))
    expect(apply).toHaveBeenCalledTimes(3)
    expect(apply.mock.calls.every(([input]) => input.hostId === scope.hostId && input.agentSessionId === scope.agentSessionId)).toBe(true)
    expect(document.querySelector('.conversation-landmark')).toBeNull()
  } finally {
    await act(async () => root.unmount()); host.remove(); frame.remove()
    document.querySelector('#agentmux-window-overlay-host')?.remove()
    vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState({ conversationLandmarkIntents: {} })
    await rm(directory, { recursive: true, force: true })
  }
})
