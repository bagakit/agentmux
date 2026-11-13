// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
import { useWorkspaceFileSource } from '../src/renderer/src/lib/use-workspace-file-source'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig } from './helpers/composer-dom-fixture'
import { WORKSPACE_FILE_SOURCE_CHUNK_BYTES } from '../src/shared/workspace-file-source'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
const readers = new Map<string, ReturnType<typeof useWorkspaceFileSource>>()
function Reader({ name = 'a', path = 'large.pdf', visible = true }: { name?: string; path?: string; visible?: boolean }) {
  const result = useWorkspaceFileSource('workspace', path, visible); readers.set(name, result)
  return <output>{result.failure?.status ?? (result.source ? 'ready' : 'waiting')}</output>
}
async function render(node: React.ReactNode) { await act(async () => root.render(node)); await act(async () => { await vi.dynamicImportSettled() }) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ config: composerConfig })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); readers.clear()
  vi.spyOn(api.files, 'releaseSource').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'cancelSourceRead').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Desktop original file source consumer', () => {
  it('does not read a snapshot or any content on open; larger demanded spans split at the IPC memory boundary', async () => {
    vi.spyOn(api.files, 'openSource').mockResolvedValue({ status: 'ready', id: 'large-source', size: 40 * 1024 * 1024 })
    const snapshot = vi.spyOn(api.files, 'readPreview')
    const read = vi.spyOn(api.files, 'readSource').mockImplementation(async (_id, _request, offset, length) => ({ status: 'read', bytes: new Uint8Array(length).fill(offset % 251) }))
    await render(<Reader />)
    expect(read).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
    const length = WORKSPACE_FILE_SOURCE_CHUNK_BYTES * 2 + 13
    const bytes = await readers.get('a')!.source!.read(17, length)
    expect(bytes.length).toBe(length)
    expect(read.mock.calls.map(args => [args[0], args[2], args[3]])).toEqual([
      ['large-source', 17, WORKSPACE_FILE_SOURCE_CHUNK_BYTES],
      ['large-source', 17 + WORKSPACE_FILE_SOURCE_CHUNK_BYTES, WORKSPACE_FILE_SOURCE_CHUNK_BYTES],
      ['large-source', 17 + WORKSPACE_FILE_SOURCE_CHUNK_BYTES * 2, 13]
    ])
    expect(new Set(read.mock.calls.map(args => args[1])).size).toBe(3)
    expect(bytes[0]).toBe(17); expect(bytes.at(-1)).toBe((17 + WORKSPACE_FILE_SOURCE_CHUNK_BYTES * 2) % 251)
  })
  it('cancels the exact pending IPC read immediately when its consumer aborts', async () => {
    vi.spyOn(api.files, 'openSource').mockResolvedValue({ status: 'ready', id: 'source', size: 100 })
    let finish!: (value: any) => void
    const read = vi.spyOn(api.files, 'readSource').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await render(<Reader />)
    const controller = new AbortController(), pending = readers.get('a')!.source!.read(10, 4, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    expect(api.files.cancelSourceRead).toHaveBeenCalledWith('source', read.mock.calls[0]![1])
    finish({ status: 'read', bytes: new Uint8Array(4) })
    expect(container.textContent).toBe('ready')
  })
  it('keeps two same-file sources independent and releases only the hidden consumer', async () => {
    let issued = 0
    vi.spyOn(api.files, 'openSource').mockImplementation(async () => ({ status: 'ready', id: `source-${++issued}`, size: 100 }))
    const read = vi.spyOn(api.files, 'readSource').mockResolvedValue({ status: 'read', bytes: new Uint8Array(4) })
    await render(<><Reader name="a" /><Reader name="b" /></>)
    const first = readers.get('a')!.source!, second = readers.get('b')!.source!
    expect(first).not.toBe(second)
    await render(<><Reader name="a" visible={false} /><Reader name="b" /></>)
    expect(api.files.releaseSource).toHaveBeenCalledExactlyOnceWith('source-1')
    await expect(first.read(0, 4)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
    await second.read(0, 4); expect(read).toHaveBeenCalledWith('source-2', expect.any(String), 0, 4)
  })
  it('releases late opens and preserves precise original file failures with a reload route', async () => {
    let finish!: (value: any) => void
    vi.spyOn(api.files, 'openSource').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ status: 'ready', id: 'current', size: 100 })
    await render(<Reader />); await render(<Reader visible={false} />)
    await act(async () => finish({ status: 'ready', id: 'late', size: 100 }))
    expect(api.files.releaseSource).toHaveBeenCalledWith('late')
    expect(readers.get('a')!.source).toBeNull()
    await render(<Reader />)
    vi.spyOn(api.files, 'readSource').mockResolvedValue({ status: 'deleted', code: 'ENOENT', message: 'Original file deleted.' })
    await act(async () => { await expect(readers.get('a')!.source!.read(0, 1)).rejects.toThrow('Original file deleted.') })
    expect(readers.get('a')!.failure?.status).toBe('deleted')
    await act(async () => readers.get('a')!.reload())
    expect(api.files.releaseSource).toHaveBeenCalledWith('current')
    expect(readers.get('a')!.source).not.toBeNull()
    expect(readers.get('a')!.failure).toBeNull()
  })
})
