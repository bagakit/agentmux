import { act } from 'react'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { fixture, mount, mounted } from './conversation-fixture'

const catalog = { spaces: [{ spaceId: 'original-space', name: 'Original retained Space', kind: 'folder', hostId: 'host-original', directoryPath: fixturePath('state-space'), projectId: null }], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
beforeEach(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) })
afterEach(async () => { for (const v of mounted.splice(0)) { await act(async () => v.root.unmount()); v.element.remove() }; vi.restoreAllMocks() })
it.each(['disconnect', 'hidden'] as const)('releases only the local spinner when the actual directory reader becomes %s and keeps the original catalog', async mode => {
  const f = fixture(), openSession = vi.fn()
  f.client.forwardRpc = vi.fn().mockResolvedValueOnce({ catalog })
  const props = { home: 'space' as const, client: f.client, connected: true, visible: true, sessions: [], openSession }
  const view = await mount(<MobileSpatialNavigation {...props} />)
  expect(view.element.textContent).toContain('Original retained Space')
  let resolve!: (value: unknown) => void
  vi.mocked(f.client.forwardRpc!).mockImplementation(() => new Promise(done => { resolve = done }) as never)
  await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="刷新空间目录"]')!.click())
  expect(view.element.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  await view.render(<MobileSpatialNavigation {...props} connected={mode !== 'disconnect'} visible={mode !== 'hidden'} />)
  expect(view.element.querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(view.element.textContent).toContain('Original retained Space')
  await act(async () => resolve({ catalog: { ...catalog, spaces: [] } }))
  expect(view.element.textContent).toContain('Original retained Space')
  expect(view.element.querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(openSession).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
it('an old directory promise cannot clear the new reader spinner or replace its retained objects', async () => {
  const f = fixture(); const original = vi.fn().mockResolvedValueOnce({ catalog }); f.client.forwardRpc = original
  const props = { home: 'space' as const, client: f.client, connected: true, sessions: [], openSession: vi.fn() }
  const view = await mount(<MobileSpatialNavigation {...props} />)
  let old!: (value: unknown) => void, current!: (value: unknown) => void
  original.mockImplementationOnce(() => new Promise(done => { old = done })).mockImplementationOnce(() => new Promise(done => { current = done }))
  await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="刷新空间目录"]')!.click())
  await view.render(<MobileSpatialNavigation {...props} connected={false} />)
  await view.render(<MobileSpatialNavigation {...props} />)
  expect(view.element.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  await act(async () => old({ catalog: { ...catalog, spaces: [] } }))
  expect(view.element.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  expect(view.element.textContent).toContain('Original retained Space')
  await act(async () => current({ catalog }))
  expect(view.element.querySelector('[data-icon-animation="spin"]')).toBeNull()
})
