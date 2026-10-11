// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { useWorkbenchWindowDocument } from '../src/renderer/src/lib/workbench-document'
import { originalWorkbenchHost, placeWorkbenchWindow, registerWorkbenchHost, workbenchWindowPlacement, type WorkbenchWindowPlacement } from '../src/renderer/src/lib/workbench-window-registry'

const target = { kind: 'tab' as const, displayWorkspaceId: 'confirmation-workspace', groupId: 'confirmation-group', tabId: 'confirmation-tab' }
const reference = { ...target, regionId: 'confirmation-region' }
const scope = { windowId: 'confirmation-child', documentGeneration: 'original-generation' }
let root: ReturnType<typeof createClientUiRoot> | undefined
let container: HTMLElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(children: ReactNode = <input defaultValue="Original unsent draft" />) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
  await act(async () => root!.render(<><div id="confirmation-home" /><div id="confirmation-away" /><div id="confirmation-later" />
    <StableWorkbenchView homeId="confirmation-home" targetId={null} primaryTabId={target.tabId} reference={reference} active visible retainedRegionId={reference.regionId}>
      {children}
    </StableWorkbenchView>
  </>))
  return { host: originalWorkbenchHost(target)!.host, home: container.querySelector<HTMLElement>('#confirmation-home')!,
    placement: { destination: container.querySelector<HTMLElement>('#confirmation-away')!, window: scope },
    later: { destination: container.querySelector<HTMLElement>('#confirmation-later')!, window: { ...scope, documentGeneration: 'later-generation' } } }
}
function outcome(promise: Promise<void>) {
  const result: { status: 'pending' | 'applied' | 'rejected'; error?: unknown } = { status: 'pending' }
  void promise.then(() => { result.status = 'applied' }, error => { result.status = 'rejected'; result.error = error })
  return result
}
it.each(['home', 'same destination'] as const)('actively confirms repeated %s requests without another render, frame or input', async kind => {
  const { host, home, placement } = await mount()
  if (kind !== 'home') {
    let first!: Promise<void>; await act(() => { first = placeWorkbenchWindow(target, placement) }); await first
  }
  const input = host.querySelector('input')!
  input.focus(); input.setSelectionRange(2, 8)
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
  for (let index = 0; index < 3; index++) {
    let result!: ReturnType<typeof outcome>
    await act(() => {
      result = outcome(placeWorkbenchWindow(target, kind === 'home' ? null : placement))
      expect(result.status, 'a request is not a physical commit').toBe('pending')
    })
    expect(result.status, 'this request initiates its own placement confirmation').toBe('applied')
    expect(host.parentElement).toBe(kind === 'home' ? home : placement.destination)
    expect(host.querySelector('input')).toBe(input)
    expect(input.value).toBe('Original unsent draft')
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
  }
  expect(frames).not.toHaveBeenCalled()
})
it.each(['home', 'same destination'] as const)('repairs the physical %s before confirming an equal requested placement', async kind => {
  const { host, home, placement, later } = await mount()
  if (kind !== 'home') {
    let first!: Promise<void>; await act(() => { first = placeWorkbenchWindow(target, placement) }); await first
  }
  const original = host.firstElementChild
  later.destination.append(host)
  let result!: ReturnType<typeof outcome>
  await act(() => { result = outcome(placeWorkbenchWindow(target, kind === 'home' ? null : placement)) })
  expect(result.status).toBe('applied')
  expect(host.parentElement).toBe(kind === 'home' ? home : placement.destination)
  expect(host.firstElementChild).toBe(original)
})
it('never acknowledges a superseded different placement as applied or rolls back the later destination', async () => {
  const { host, placement, later } = await mount()
  let first!: ReturnType<typeof outcome>, second!: ReturnType<typeof outcome>
  await act(() => {
    first = outcome(placeWorkbenchWindow(target, placement))
    second = outcome(placeWorkbenchWindow(target, later))
  })
  expect(first.status).toBe('rejected')
  expect(second.status).toBe('applied')
  expect(host.parentElement).toBe(later.destination)
  expect(workbenchWindowPlacement(target)).toBe(later)
})
it('does not let an earlier render confirm a request issued by a later document-context commit', async () => {
  let later: WorkbenchWindowPlacement | undefined, next: ReturnType<typeof outcome> | undefined
  function OriginalContent() {
    const current = useWorkbenchWindowDocument()
    useLayoutEffect(() => {
      if (current?.documentGeneration === 'request-in-layout' && later && !next) next = outcome(placeWorkbenchWindow(target, later))
    }, [current])
    return <input defaultValue="Original context draft" />
  }
  const mounted = await mount(<OriginalContent />); later = { ...mounted.later, destination: mounted.placement.destination }
  const input = mounted.host.querySelector('input')!
  let first!: Promise<void>
  await act(() => { first = placeWorkbenchWindow(target, mounted.placement) }); await first
  let previous!: ReturnType<typeof outcome>
  await act(() => { previous = outcome(placeWorkbenchWindow(target, { ...mounted.placement, window: { ...scope, documentGeneration: 'request-in-layout' } })) })
  expect(previous.status).toBe('rejected')
  expect(next?.status).toBe('applied')
  expect(mounted.host.parentElement).toBe(later.destination)
  expect(mounted.host.querySelector('input')).toBe(input)
  expect(workbenchWindowPlacement(target)).toBe(later)
})
it('confirms compatible concurrent repeats from their actual committed host', async () => {
  const { host, home } = await mount()
  let first!: ReturnType<typeof outcome>, second!: ReturnType<typeof outcome>
  await act(() => {
    first = outcome(placeWorkbenchWindow(target, null))
    second = outcome(placeWorkbenchWindow(target, null))
    expect([first.status, second.status]).toEqual(['pending', 'pending'])
  })
  expect([first.status, second.status]).toEqual(['applied', 'applied'])
  expect(host.parentElement).toBe(home)
})
it.each([false, true])('keeps a missing home pending and handles a later replacement without rollback=%s', async replace => {
  const { host, home, placement, later } = await mount()
  let away!: Promise<void>; await act(() => { away = placeWorkbenchWindow(target, placement) }); await away
  home.id = 'unavailable-original-home'
  let returning!: ReturnType<typeof outcome>
  await act(() => { returning = outcome(placeWorkbenchWindow(target, null)) })
  expect(returning.status).toBe('pending')
  expect(host.parentElement).toBe(placement.destination)
  if (replace) {
    let latest!: ReturnType<typeof outcome>
    await act(() => { latest = outcome(placeWorkbenchWindow(target, later)) })
    expect(latest.status).toBe('applied')
    expect(returning.status).toBe('rejected')
  }
  const replacementHome = document.createElement('div'); replacementHome.id = 'confirmation-home'
  await act(async () => { container!.prepend(replacementHome); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(returning.status).toBe(replace ? 'rejected' : 'applied')
  expect(host.parentElement).toBe(replace ? later.destination : replacementHome)
  expect(workbenchWindowPlacement(target)).toBe(replace ? later : null)
})
it('rejects an unconfirmed missing-home request when its original host unmounts', async () => {
  const { home, placement } = await mount()
  let away!: Promise<void>; await act(() => { away = placeWorkbenchWindow(target, placement) }); await away
  home.id = 'unavailable-original-home'
  let returning!: ReturnType<typeof outcome>
  await act(() => { returning = outcome(placeWorkbenchWindow(target, null)) })
  expect(returning.status).toBe('pending')
  await act(async () => root!.unmount()); root = undefined
  expect(returning.status).toBe('rejected')
})
it('a late failure cannot roll back a newer confirmed request even when both use the exact same placement object', async () => {
  const host = document.createElement('div'), destination = document.createElement('div')
  const placement = { destination, window: scope }
  let failPrevious!: (error: Error) => void, confirmLatest!: () => void
  const place = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failPrevious = reject }))
    .mockImplementationOnce(() => new Promise<void>(resolve => { confirmLatest = resolve })).mockResolvedValue(undefined)
  const release = registerWorkbenchHost({ target, host, place })
  try {
    const previous = outcome(placeWorkbenchWindow(target, placement)), latest = placeWorkbenchWindow(target, placement)
    confirmLatest(); await latest
    failPrevious(new Error('Original older placement failed'))
    await Promise.resolve(); await Promise.resolve()
    expect(previous.status).toBe('rejected')
    expect(workbenchWindowPlacement(target)).toBe(placement)
  } finally { await placeWorkbenchWindow(target, null); release() }
})
