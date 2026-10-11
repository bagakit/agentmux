// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
const checkpoint = vi.hoisted(() => ({ prepare: vi.fn(async () => {}), flush: vi.fn(async () => {}), order: [] as string[], roots: [] as Root[] }))
vi.mock('../src/renderer/src/App', () => ({ App: () => null }))
vi.mock('../src/renderer/src/components/DesktopClientUiProvider', () => ({ DesktopClientUiProvider: ({ children }: { children: unknown }) => children }))
vi.mock('../src/renderer/src/store', () => ({ prepareRendererUpdate: checkpoint.prepare,
  useAppStore: { getState: () => ({ reportError: vi.fn(), reportWorkbenchSaveFailure: vi.fn() }) } }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { ui: { requestStorageFlush: checkpoint.flush } } }))
vi.mock('react-dom/client', async original => {
  const actual = await original<typeof import('react-dom/client')>()
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => { const root = actual.createRoot(...args); checkpoint.roots.push(root); return root } }
})
it('the actual renderer checkpoint saves bookmarks before the original preparation and keeps saving failure nonblocking', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host)
  checkpoint.flush.mockImplementation(async () => { checkpoint.order.push('bookmark-flush') })
  checkpoint.prepare.mockImplementation(async () => { checkpoint.order.push('original-workbench') })
  const { agentBookmarks, AGENT_BOOKMARK_STORAGE_KEY } = await import('../src/renderer/src/lib/agent-bookmarks')
  try {
    await act(async () => { await import('../src/renderer/src/main') })
    const input = { hostId: 'original-host', agentSessionId: 'original-canonical', presentationId: 'display', label: 'Original bookmark', workspaceName: 'Project', bounds: { x: 20, y: 30, width: 500, height: 600 } }
    const key = agentBookmarks.pin(input)!
    const prepare = (window as unknown as { agentmuxPrepareRendererUpdate(intent: 'quit' | 'reload'): Promise<void> }).agentmuxPrepareRendererUpdate
    await prepare('quit')
    expect(localStorage.getItem(AGENT_BOOKMARK_STORAGE_KEY)).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(AGENT_BOOKMARK_STORAGE_KEY)!).bookmarks[0].key).toBe(key)
    expect(checkpoint.order).toEqual(['bookmark-flush', 'original-workbench']); expect(checkpoint.prepare).toHaveBeenCalledWith('quit')
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage denied') })
    agentBookmarks.setBounds(key, { ...input.bounds, x: 88 }); checkpoint.order.length = 0
    await expect(prepare('reload')).resolves.toBeUndefined()
    expect(checkpoint.prepare).toHaveBeenLastCalledWith('reload'); expect(checkpoint.order).toEqual(['original-workbench'])
    expect(agentBookmarks.get().bookmarks[0]!.bounds.x).toBe(88); expect(agentBookmarks.get().persistenceIssue?.phase).toBe('write')
    write.mockRestore(); await agentBookmarks.retry()
    let finish!: () => void
    checkpoint.flush.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    agentBookmarks.setBounds(key, { ...input.bounds, x: 99 }); checkpoint.order.length = 0
    await expect(prepare('quit')).resolves.toBeUndefined()
    expect(checkpoint.order).toEqual(['original-workbench']); expect(JSON.parse(localStorage.getItem(AGENT_BOOKMARK_STORAGE_KEY)!).bookmarks[0].bounds.x).toBe(99)
    finish(); await agentBookmarks.flush(); agentBookmarks.remove(key); await agentBookmarks.flush()
  } finally {
    agentBookmarks.stopLifecycle()
    for (const root of checkpoint.roots.splice(0)) await act(async () => root.unmount())
    host.remove(); localStorage.removeItem(AGENT_BOOKMARK_STORAGE_KEY); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
