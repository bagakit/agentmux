// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { observeWorkbenchNativeVisibility, registerWorkbenchDocument, useWorkbenchDocumentVisibility } from '../src/renderer/src/lib/workbench-window-registry'
import type { AppWindowDescriptor } from '@agentmux/core/control'

it('wakes only the exact document visibility consumer and releases its original observation listener', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), frame = document.createElement('iframe')
  document.body.append(container, frame)
  const child = frame.contentDocument!, root = createRoot(container)
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  let mainReads = 0
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => { mainReads++; return 'visible' } })
  const rootIdentity = { windowId: 'main', documentGeneration: 'main-document' }, childIdentity = { windowId: 'child', documentGeneration: 'child-document' }
  const remove = vi.spyOn(child, 'removeEventListener')
  const releaseMain = registerWorkbenchDocument(document, rootIdentity), releaseChild = registerWorkbenchDocument(child, childIdentity)
  const commits = { main: 0, child: 0 }
  function OriginalConsumer({ owner, name }: { owner: Document; name: 'main' | 'child' }) {
    const visible = useWorkbenchDocumentVisibility(owner)
    commits[name]++
    return <output data-document={name}>{visible ? 'visible' : 'hidden'}</output>
  }
  const descriptor = (presentation: AppWindowDescriptor['presentation'], documentGeneration = childIdentity.documentGeneration): AppWindowDescriptor => ({ ...childIdentity, documentGeneration, target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' }, presentation, bounds: null, focused: null })
  try {
    await act(async () => root.render(<><OriginalConsumer owner={document} name="main" /><OriginalConsumer owner={child} name="child" /></>))
    const baseline = { ...commits }, baselineReads = mainReads
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden', 'stale-document')]))
    expect(commits).toEqual(baseline)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden')]))
    expect(container.querySelector('[data-document=child]')!.textContent).toBe('hidden')
    expect(commits.main).toBe(baseline.main); expect(mainReads).toBe(baselineReads)
    const hidden = { ...commits }
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden')]))
    expect(commits).toEqual(hidden)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('unknown')]))
    expect(commits).toEqual(hidden)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('visible')]))
    expect(container.querySelector('[data-document=child]')!.textContent).toBe('visible')
    expect(commits.main).toBe(baseline.main); expect(mainReads).toBe(baselineReads)
    Object.defineProperty(child, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => child.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelector('[data-document=child]')!.textContent).toBe('hidden')
    expect(commits.main).toBe(baseline.main); expect(mainReads).toBe(baselineReads)
    Object.defineProperty(child, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => child.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelector('[data-document=child]')!.textContent).toBe('visible')
  } finally {
    await act(async () => root.unmount()); releaseMain(); releaseChild()
    expect(remove.mock.calls.some(([event]) => event === 'visibilitychange')).toBe(true)
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility); else Reflect.deleteProperty(document, 'visibilityState')
    container.remove(); frame.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
