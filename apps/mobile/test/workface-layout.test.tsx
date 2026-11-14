import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { mobileWorkfaceLayout } from '../src/layout/workface-presentation'
import { useMobileWorkfaceLayout } from '../src/layout/use-mobile-workface-layout'
import { bindMobileViewport, readMobileViewport, subscribeMobileViewport } from '../src/platform/native/device'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted } from './conversation-fixture'

const resources: { path: string; files: WorkspaceFiles }[] = []
const styles: HTMLStyleElement[] = []
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const value of resources.splice(0)) { await value.files.dispose(); await rm(value.path, { recursive: true, force: true }) }
  for (const style of styles.splice(0)) style.remove()
  vi.restoreAllMocks(); localStorage.clear()
})
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 4000 })

it('workface Space keeps the real original file and its binding catalog active when the compact navigation is hidden', async () => {
  const style = document.createElement('style'); style.textContent = readFileSync(resolve(import.meta.dirname, '../src/layout/workface.css'), 'utf8'); document.head.append(style); styles.push(style)
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-workface-space-')))
  await mkdir(join(path, 'workspace')); const workspacePath = join(path, 'workspace')
  await writeFile(join(workspacePath, 'original.md'), '# Original workface file\n\nSame original file bytes.')
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost)); resources.push({ path, files })
  const workspace = { id: 'workface-workspace', hostId: 'local', name: 'Workface workspace', path: workspacePath, kind: 'folder' as const }
  const catalog: AgentMuxSpaceCatalog = { spaces: [{ spaceId: 'workface-space', kind: 'folder', name: 'Original workface project', hostId: 'local', directoryPath: workspacePath, projectId: null }],
    zones: [{ zoneId: 'workface-zone', workspaceId: workspace.id, hostId: 'local', directoryPath: workspacePath, kind: 'directory', branch: null }],
    tabs: [{ tabId: 'workface-tab', zoneId: 'workface-zone', workspaceId: workspace.id, name: 'Original file', regionIds: ['workface-region'] }],
    regions: [{ tabId: 'workface-tab', regionId: 'workface-region', kind: 'file', agentSessionId: null, runId: null, execution: null,
      file: { workspaceId: workspace.id, path: 'original.md', zoneRelativePath: 'original.md' } }],
    bindings: [{ spaceId: 'workface-space', zoneId: 'workface-zone' }], locations: [], agentPresentation: [] }
  const fileOwner = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined, catalog: async () => catalog })
  const service = new AgentMuxRpcService({ files: fileOwner, coreClients: () => [] })
  const f = fixture(), forward = vi.fn(async (method: string, input: any) => {
    if (method === 'space.ls' || method === 'space.inspect') return { catalog: structuredClone(catalog) }
    if (method === 'app.snapshot') return { workspaces: [{ ...workspace, workspaceId: workspace.id, projectId: null, repoPath: null, branch: null }], agents: [], unavailable: [] }
    return service.call(method as any, input, { principal: { kind: 'device', id: 'private-workface-device' } })
  })
  f.client.forwardRpc = forward as NonNullable<typeof f.client.forwardRpc>
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  const open = vi.fn(), initialContext = { spaceId: 'workface-space', tabId: 'workface-tab', regionId: 'workface-region' }
  const render = (active: boolean, width: number) => <MobileSpatialNavigation home="space" client={f.client} connected visible={active}
    wide={mobileWorkfaceLayout({ width, height: 375 }).split} initialContext={initialContext} openSession={open} />
  const view = await mount(render(true, 667))
  await wait(() => expect(view.element.querySelector('.mobile-region-content')?.textContent).toContain('Same original file bytes.'))
  const navigation = view.element.querySelector<HTMLElement>('.mobile-space-navigation')!, content = view.element.querySelector<HTMLElement>('.mobile-space-content')!
  const reader = view.element.querySelector('.mobile-region-content')!, tree = view.element.querySelector('.mobile-space-directory')!
  expect(navigation.closest('.mobile-workface-frame')).not.toBeNull()
  expect(navigation.hidden).toBe(false)
  const reads = () => forward.mock.calls.filter(([method]) => method === 'space.ls').length
  const filesRead = () => forward.mock.calls.filter(([method]) => method === 'file.read')
  const initialReads = reads(), saved = getDeviceWorkface().exportBackup()
  await view.render(render(true, 390))
  expect(navigation.hidden).toBe(true); expect(content.hidden).toBe(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(reads(), 'The selected original Space still needs its catalog when only its content is presented.').toBe(initialReads + 1)
  expect(filesRead()).toHaveLength(1)
  for (const width of [812, 320, 1024, 667]) {
    await view.render(render(true, width))
    expect(view.element.querySelector('.mobile-region-content')).toBe(reader)
    expect(view.element.querySelector('.mobile-space-directory')).toBe(tree)
    expect(navigation.hidden).toBe(width < 600)
  }
  const calls = forward.mock.calls.length
  await view.render(render(false, 667))
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(navigation.hidden).toBe(false); expect(content.hidden).toBe(false)
  expect(reader.closest('[hidden]')).toBeNull()
  expect(forward.mock.calls).toHaveLength(calls)
  expect(getDeviceWorkface().exportBackup()).toBe(saved)
  expect(filesRead()[0]![1]).toEqual({ zoneId: 'workface-zone', path: 'original.md', expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath } })
  const frame = navigation.closest<HTMLElement>('.mobile-workface-frame')!
  await view.render(<MobileSpatialNavigation home="focus" client={f.client} connected visible wide openSession={open} />)
  expect(frame.hidden).toBe(true)
  expect(getComputedStyle(frame).display, 'The retained Space frame must not paint over the actual Focus workface.').toBe('none')
  expect(view.element.querySelector('.mobile-focus-facet')).not.toBeNull()
  expect(open).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('workface viewport consumers share the original coalesced producer and keyboard height cannot change the width budget', async () => {
  const originalWidth = window.innerWidth, originalHeight = window.innerHeight, originalViewport = window.visualViewport
  const viewport = new EventTarget(); Object.assign(viewport, { height: 375, offsetTop: 0, scale: 1, width: 667 })
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 667 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 375 })
  const frames = new Map<number, FrameRequestCallback>(); let next = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  const first = vi.fn(), second = vi.fn(), removeFirst = subscribeMobileViewport(window, first), removeSecond = subscribeMobileViewport(window, second)
  const release = bindMobileViewport(window, document.documentElement)
  const renders = vi.fn()
  function LayoutConsumer() { const layout = useMobileWorkfaceLayout(); renders(layout); return <div data-layout-split={layout.split} data-layout-short={layout.short} /> }
  const view = await mount(<LayoutConsumer />)
  try {
    expect(mobileWorkfaceLayout(readMobileViewport(window)).split).toBe(true)
    const original = readMobileViewport(window); first.mockClear(); second.mockClear()
    const originalRenders = renders.mock.calls.length
    Object.assign(viewport, { height: 190, width: 260, offsetTop: 8 })
    viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(1)
    const [id, callback] = [...frames][0]!; frames.delete(id); await act(async () => callback(0))
    expect(readMobileViewport(window)).not.toBe(original)
    expect(readMobileViewport(window).width).toBe(667)
    expect(mobileWorkfaceLayout(readMobileViewport(window)).split, 'Keyboard and visual viewport width must not replace original layout width.').toBe(true)
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1)
    expect(renders.mock.calls, 'The actual layout consumer must not render for another height inside the same split/short presentation.').toHaveLength(originalRenders)
    first.mockClear(); Object.assign(viewport, { offsetTop: 9 }); viewport.dispatchEvent(new Event('scroll'))
    const [sameId, same] = [...frames][0]!; frames.delete(sameId); await act(async () => same(0))
    expect(first).not.toHaveBeenCalled()
    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-top')).toBe('9px')
    Object.assign(viewport, { height: 500 }); viewport.dispatchEvent(new Event('resize'))
    const [tallId, tall] = [...frames][0]!; frames.delete(tallId); await act(async () => tall(0))
    expect(renders).toHaveBeenCalledTimes(originalRenders + 1)
    expect(view.element.querySelector('[data-layout-short]')?.getAttribute('data-layout-short')).toBe('false')
    Object.assign(viewport, { scale: 2, height: 100 }); viewport.dispatchEvent(new Event('resize'))
    const [zoomId, zoom] = [...frames][0]!; frames.delete(zoomId); zoom(0)
    expect(readMobileViewport(window).height).toBe(500)
  } finally {
    release(); removeFirst(); removeSecond()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: originalViewport })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
  }
})
