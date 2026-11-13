// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
const boundary = vi.hoisted(() => {
  let releaseEngine!: () => void
  const engineGate = new Promise<void>(resolve => { releaseEngine = resolve })
  return { engineGate, releaseEngine, engineEvaluations: 0, engineReady: false, viewerEvaluations: 0, getDocument: vi.fn(), workerCreate: vi.fn() }
})
vi.mock('pdfjs-dist', async () => {
  boundary.engineEvaluations++; await boundary.engineGate; boundary.engineReady = true
  return { getDocument: boundary.getDocument, PDFWorker: { create: boundary.workerCreate }, GlobalWorkerOptions: {} }
})
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  boundary.viewerEvaluations++
  if (!boundary.engineReady) throw new Error('The viewer evaluated before the engine global was initialized')
  return {}
})
import * as reader from '@agentmux/editor-extensions/pdf'
import { usePreparePdfReader } from '../src/renderer/src/lib/use-prepare-pdf-reader'
import { useWorkspaceFileSource } from '../src/renderer/src/lib/use-workspace-file-source'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig } from './helpers/composer-dom-fixture'

it('prepares visible PDF code while the original source is pending, without a worker or bytes, and fences hidden preparation', async () => {
  const initial = useAppStore.getState(), container = document.createElement('div'), root = createRoot(container)
  document.body.append(container); useAppStore.setState({ config: composerConfig }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const pending: Array<(result: any) => void> = []
  const prepare = vi.spyOn(reader, 'preparePdfReader'), open = vi.spyOn(api.files, 'openSource').mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  const bytes = vi.spyOn(api.files, 'readSource'), snapshot = vi.spyOn(api.files, 'readPreview'), release = vi.spyOn(api.files, 'releaseSource').mockResolvedValue(undefined)
  let source: ReturnType<typeof useWorkspaceFileSource>['source'] = null
  function Workface({ visible }: { visible: boolean }) {
    source = useWorkspaceFileSource('workspace', 'large.pdf', visible).source
    usePreparePdfReader(visible)
    return <output>{source ? 'source ready' : 'source pending'}</output>
  }
  const render = async (visible: boolean) => { await act(async () => root.render(<Workface visible={visible} />)) }
  try {
    await render(false); expect(prepare).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    await render(true)
    await act(async () => { await vi.waitFor(() => expect(boundary.engineEvaluations).toBe(1)) })
    expect(open).toHaveBeenCalledOnce(); expect(source).toBeNull(); expect(prepare).toHaveBeenCalledOnce()
    expect(boundary.viewerEvaluations).toBe(0)
    await render(false); boundary.releaseEngine()
    await act(async () => { await vi.dynamicImportSettled() })
    expect(boundary.viewerEvaluations).toBe(0)
    await render(true)
    await act(async () => { await vi.dynamicImportSettled() })
    expect(open).toHaveBeenCalledTimes(2); expect(source).toBeNull(); expect(prepare).toHaveBeenCalledTimes(2)
    expect(boundary.viewerEvaluations).toBe(1); expect(boundary.engineEvaluations).toBe(1)
    expect(boundary.getDocument).not.toHaveBeenCalled(); expect(boundary.workerCreate).not.toHaveBeenCalled()
    expect(bytes).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
    await render(false)
    await act(async () => { pending.forEach((finish, index) => finish({ status: 'ready', id: 'late-' + index, size: 40 * 1024 * 1024 })) })
    expect(release.mock.calls).toEqual([['late-0'], ['late-1']]); expect(source).toBeNull()
    expect(prepare).toHaveBeenCalledTimes(2)
  } finally {
    boundary.releaseEngine(); await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
