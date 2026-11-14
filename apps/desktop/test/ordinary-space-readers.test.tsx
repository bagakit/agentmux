// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SpaceSourceReaders, useSpaceSourceReader } from '../src/renderer/src/components/SpaceSourceReaders'
import { MountedSpaceFocus } from '../src/renderer/src/components/MountedSpaceFocus'
import { spaceMountKey } from '../src/shared/space-mount'
import type { SpaceMountRecord } from '../src/shared/space-mount'

const cleanup: Array<() => unknown | Promise<unknown>> = []
let root: Root | undefined
const before = useAppStore.getState()
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  for (const close of cleanup.splice(0).reverse()) await close()
  useAppStore.setState(before, true); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function VisibleConsumer({ target, visible, label }: { target: SpaceMountRecord; visible: boolean; label: string }) {
  const refresh = useSpaceSourceReader(target, visible)
  return visible ? <button onClick={refresh}>{label}</button> : null
}
it('ordinary source readers share the existing real Main/Core scope and only the last visible consumer releases it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await createSpaceSessionsFixture(cleanup)
  const main = spaceMountTransport(cleanup, [{ id: 'original-B', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }])
  const metadata = vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  const business = vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  const target = { hostId: 'original-B', reference: f.reference, zoneId: 'original-zone', workspaceId: 'original-b-project' }
  useAppStore.setState({ mountedSpaceInputs: { [spaceMountKey(target.reference)]: { target: { ...target, reference: { spaceId: target.reference.spaceId, runtimeId: target.reference.runtimeId } }, drafts: {} } } })
  const state = useAppStore.getState()
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  const view = (first: boolean, second: boolean, mounted = false) => <SpaceSourceReaders>
    <MountedSpaceFocus visible={mounted} query="" />
    <VisibleConsumer target={target} visible={first} label="First Region" />
    <VisibleConsumer target={target} visible={second} label="Second Region" />
  </SpaceSourceReaders>
  await act(async () => root!.render(view(true, true, true)))
  await vi.waitFor(() => { expect(metadata).toHaveBeenCalledOnce(); expect(business).toHaveBeenCalledOnce() })
  await act(async () => root!.render(view(false, true)))
  expect(metadata).toHaveBeenCalledOnce(); expect(business).toHaveBeenCalledOnce()
  expect(metadata.mock.calls[0]![2]!.aborted).toBe(false)
  await act(async () => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Second Region')!.click())
  await vi.waitFor(() => { expect(metadata).toHaveBeenCalledTimes(2); expect(business).toHaveBeenCalledTimes(2) })
  expect(metadata.mock.calls[0]![2]!.aborted).toBe(true)
  expect(metadata.mock.calls[1]![2]!.aborted).toBe(false)
  await act(async () => root!.render(view(false, false)))
  expect(metadata.mock.calls[1]![2]!.aborted).toBe(true)
  expect(business.mock.calls[1]![2]!.aborted).toBe(true)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(state.mountedSpaceInputs)
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})
