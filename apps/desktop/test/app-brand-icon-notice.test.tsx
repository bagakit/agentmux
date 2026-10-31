// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices.js'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { composerConfig } from './helpers/composer-dom-fixture'
import { currentNotificationRows, markShownNotificationsRead, toggleNotificationCenter } from './helpers/notification-center'

const initial = useAppStore.getState()
let element: HTMLDivElement, root: Root, dispose: (() => void) | undefined
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
beforeEach(() => {
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], appIconIssue: 'The Dock image is unavailable.' })
  useAppStore.setState({ ...initial, noticeReadReceipts: {} }, true)
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => { dispose?.(); root.unmount() })
  dispose = undefined
  element.remove()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

it('does not turn an omitted native observation into recovery of a previously confirmed image failure', async () => {
  useAppStore.setState({ appIconIssue: 'Original native image failure' })
  vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  await act(async () => { dispose = await useAppStore.getState().initialize() })
  expect(useAppStore.getState().appIconIssue).toBe('Original native image failure')
  await act(async () => { dispose!(); dispose = undefined })
  vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], appIconIssue: null })
  await act(async () => { dispose = await useAppStore.getState().initialize() })
  expect(useAppStore.getState().appIconIssue).toBeNull()
})

it('retains the native issue through reading and unrelated updates, and clears it only on a confirmed native recovery', async () => {
  let changed!: (issue: string | null) => void
  const unsubscribe = vi.fn()
  vi.spyOn(api.ui, 'onAppIconIssue').mockImplementation(listener => { changed = listener; return unsubscribe })
  await act(async () => { dispose = await useAppStore.getState().initialize(); root.render(<GlobalSystemNotices />) })
  expect(useAppStore.getState().appIconIssue).toBe('The Dock image is unavailable.')
  await toggleNotificationCenter(element, 'open')
  expect(currentNotificationRows(element).some(row => row.dataset.noticeId === 'app-icon')).toBe(true)
  expect(element.textContent).toContain('System App icon needs attention')
  await markShownNotificationsRead(element)
  await act(async () => useAppStore.setState({ config: { ...composerConfig, copyPathsAsAbsolute: true } }))
  expect(currentNotificationRows(element).some(row => row.dataset.noticeId === 'app-icon')).toBe(true)
  expect(useAppStore.getState().appIconIssue).toBe('The Dock image is unavailable.')
  await act(async () => changed('The preferred image could not be loaded.'))
  expect(useAppStore.getState().appIconIssue).toContain('preferred image')
  expect(currentNotificationRows(element).some(row => row.dataset.noticeId === 'app-icon')).toBe(true)
  await act(async () => changed(null))
  expect(useAppStore.getState().appIconIssue).toBeNull()
  expect(currentNotificationRows(element).some(row => row.dataset.noticeId === 'app-icon')).toBe(false)
  dispose!(); dispose = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
})
