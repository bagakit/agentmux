// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '@agentmux/core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { createClientUiRoot } from './helpers/client-ui-render'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Original source painter" value={value} readOnly /> }))
vi.mock('monaco-editor', async () => (await import('./helpers/workface-monaco-fixture')).workfaceMonacoAdapter())
import { startWorkfaceFileFixture, zoneFor } from './helpers/workface-file-fixture'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const paths = ['manual.PDF', 'chapter.epub', 'novel.mobi', 'reader.azw3', 'comic.cbz', 'comic.cbr', 'scan.djvu', 'scan.DJV']
const initial = useAppStore.getState(), exec = promisify(execFile)
let fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>>, root: Root, container: HTMLDivElement
const receipts: unknown[] = []
const originalDraft = { path: 'untouched.md', content: '# Original unsaved draft', revision: 'original-draft-revision' }
const draftKey = documentKey('resource', originalDraft.path)

beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture = await startWorkfaceFileFixture()
  vi.spyOn(api.files, 'write')
  useAppStore.setState({ documents: { [draftKey]: originalDraft }, dirtyDocuments: { [draftKey]: true } })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); expect(api.files.write).not.toHaveBeenCalled(); container.remove(); await fixture.stop()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function protectedFacts() {
  const state = useAppStore.getState()
  return { sessions: state.sessions, drafts: state.agentComposerDrafts, queues: state.agentSteerQueues,
    activeWorkspace: state.activeWorkspaceId, selection: state.workbenchSpaceSelection, focus: state.agentFocus,
    originalTab: state.tabs['workface-original-tab'], dirtyDocument: state.documents[draftKey], dirty: state.dirtyDocuments[draftKey] }
}
function noByteOrTextRead() {
  expect(api.files.read).not.toHaveBeenCalled()
  expect(api.files.observe).not.toHaveBeenCalled()
  expect(api.files.readPreview).not.toHaveBeenCalled()
}
async function open(path: string) {
  return fixture.run('file.open', ['file', 'open', '--zone', zoneFor('resource').zoneId, '--path', path])
}

describe('Editor extensions through actual public CLI, Unix RPC and original Desktop File owner', () => {
  it.each(paths)('opens %s without a UTF-8 snapshot and discovers only its original read-only File view', async path => {
    const before = protectedFacts(), opened = await open(path)
    expect(opened).toMatchObject({ requestedPath: path, data: { kind: 'media-preview', reason: null },
      resource: { workspaceId: 'resource', path }, placement: { status: 'created' }, navigation: 'background', outcome: 'opened' })
    const tab = useAppStore.getState().tabs[opened.placement.tabId!]!, region = tab.regions[opened.placement.regionId!]!
    expect(region).toMatchObject({ kind: 'file', regionId: opened.placement.regionId, workspaceId: 'resource', path })
    expect(useAppStore.getState().documents[documentKey('resource', path)]).toBeUndefined()
    expect(useAppStore.getState().documentIssues[documentKey('resource', path)]).toBeUndefined()
    const viewed = await fixture.run('file.view', ['file', 'view', '--region', region.regionId])
    expect(viewed).toMatchObject({ regionId: region.regionId, tabId: tab.id, supportedModes: ['preview'],
      effectiveMode: 'preview', data: 'media-preview', content: { status: 'unconfirmed' }, outcome: 'read', changed: false })
    // The real File consumer stays present while hidden, without starting a decoder or a byte reader.
    await act(async () => root.render(<FileSurfaceView tabId={tab.id} surface={region as FileWorkbenchSurface} visible={false} />))
    expect(container.querySelector('.file-preview-pane')).not.toBeNull()
    expect(container.textContent).toContain(path)
    expect(container.querySelector('.monaco-editor, textarea, iframe')).toBeNull()
    const refused = await fixture.run('file.view', ['file', 'view', '--region', region.regionId, '--mode', 'source'], 1)
    expect(refused).toMatchObject({ outcome: 'refused', effectiveMode: 'preview', supportedModes: ['preview'],
      issues: [{ code: 'FILE_MODE_UNSUPPORTED' }] })
    expect(useAppStore.getState().tabs[tab.id]?.regions[region.regionId]).toBe(region)
    noByteOrTextRead(); expect(protectedFacts()).toEqual(before)
    expect(useAppStore.getState().documents[draftKey]).toBe(originalDraft)
    fixture.noLifecycle()
    expect(fixture.seen.some(request => request.operation === 'open.file' && request.path === path)).toBe(true)
    expect(fixture.seen.some(request => request.operation === 'space.view' && request.regionId === region.regionId)).toBe(true)
    receipts.push({ path, opened, viewed, refused, hiddenPane: true, textAndPreviewReads: 0 })
  })

  it('uses the same original File identity through the typed SDK and compiled CLI over real JSON-RPC', async () => {
    const path = 'typed-reader.epub', opened = await open(path), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(fixture.directory, 'control.sock') } })
    const before = protectedFacts()
    try {
      const typedOpen = await client.call('file.open', { path, zoneId: zoneFor('resource').zoneId, focus: false })
      expect(typedOpen).toMatchObject({ placement: { status: 'reused', tabId: opened.placement.tabId, regionId: opened.placement.regionId }, data: { kind: 'media-preview' }, outcome: 'unchanged' })
      const typedView = await client.call('file.view', { regionId: opened.placement.regionId! })
      expect(typedView).toMatchObject({ effectiveMode: 'preview', supportedModes: ['preview'], data: 'media-preview', content: { status: 'unconfirmed' } })
      receipts.push({ path, opened, typedOpen, typedView })
    } finally { await client.dispose() }
    noByteOrTextRead(); expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
  })

  it('discovers FB2 reading and editing without requiring a text snapshot before its default Preview', async () => {
    const path = 'classic.fb2', before = protectedFacts(), opened = await open(path)
    expect(opened).toMatchObject({ data: { kind: 'media-preview' }, placement: { status: 'created' }, outcome: 'opened' })
    const viewed = await fixture.run('file.view', ['file', 'view', '--region', opened.placement.regionId!])
    expect(viewed).toMatchObject({ effectiveMode: 'preview', supportedModes: ['source', 'diff', 'preview'], content: { status: 'unconfirmed' } })
    noByteOrTextRead(); expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
    receipts.push({ path, opened, viewed, textAndPreviewReads: 0 })
  })

  it.each([false, true])('keeps an existing dirty FB2 XML draft reachable through its original public Source and File surface (disk binary=%s)', async diskBinary => {
    const path = 'draft.fb2', key = documentKey('resource', path)
    const draft = { path, content: '<?xml version="1.0"?><FictionBook><body><section><p>Original unsaved XML</p></section></body></FictionBook>', revision: 'saved-fb2-revision' }
    useAppStore.setState(state => ({ documents: { ...state.documents, [key]: draft }, dirtyDocuments: { ...state.dirtyDocuments, [key]: true } }))
    if (diskBinary) useAppStore.setState(state => ({ documentIssues: { ...state.documentIssues, [key]: { kind: 'binary', revision: 'new-disk-revision', byteLength: 640 } } }))
    const before = protectedFacts(), opened = await open(path)
    expect(opened).toMatchObject({ data: { kind: 'text' }, placement: { status: 'created' }, outcome: 'opened' })
    const automatic = await fixture.run('file.view', ['file', 'view', '--region', opened.placement.regionId!])
    expect(automatic).toMatchObject({ effectiveMode: 'source', data: 'text', content: { status: 'available' } })
    const preview = await fixture.run('file.view', ['file', 'view', '--region', opened.placement.regionId!, '--mode', 'preview'])
    expect(preview).toMatchObject({ effectiveMode: 'preview', data: 'text', content: { status: 'unconfirmed' } })
    const source = await fixture.run('file.view', ['file', 'view', '--region', opened.placement.regionId!, '--mode', 'source'])
    expect(source).toMatchObject({ effectiveMode: 'source', supportedModes: ['source', 'diff', 'preview'], data: 'text', content: { status: 'available' } })
    const tab = useAppStore.getState().tabs[opened.placement.tabId!]!, surface = tab.regions[opened.placement.regionId!] as FileWorkbenchSurface
    await act(async () => root.render(<FileSurfaceView tabId={tab.id} surface={surface} />))
    await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) })
    await vi.waitFor(() => expect(container.querySelector('textarea')?.value).toContain('Original unsaved XML'))
    expect(useAppStore.getState().documents[key]).toBe(draft); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
    receipts.push({ path, diskBinary, opened, automatic, preview, source, dirtyDraftSourceReachable: true })
  })

  it('does not invent an editable FB2 buffer from a dirty flag when the known disk data is binary', async () => {
    const path = 'disk-only.fb2', key = documentKey('resource', path)
    useAppStore.setState(state => ({ dirtyDocuments: { ...state.dirtyDocuments, [key]: true }, documentIssues: {
      ...state.documentIssues, [key]: { kind: 'binary', revision: 'disk-binary-revision', byteLength: 640 } } }))
    const opened = await open(path), viewed = await fixture.run('file.view', ['file', 'view', '--region', opened.placement.regionId!])
    expect(viewed).toMatchObject({ supportedModes: ['preview'], effectiveMode: 'preview', data: 'binary-preview', content: { status: 'unconfirmed' } })
    expect(useAppStore.getState().documents[key]).toBeUndefined()
    noByteOrTextRead(); fixture.noLifecycle()
    receipts.push({ path, opened, viewed, noInventedBuffer: true })
  })

  it('discovers the existing exact grammar without inventing a format-specific public command or byte API', async () => {
    const before = fixture.seen.length
    const help = await Promise.all(['open', 'view'].map(action => exec(process.execPath,
      [join(process.cwd(), 'packages/core/bin/amux'), 'file', action, '--help'], { env: fixture.env, timeout: 8000 })))
    expect(help[0]!.stdout).toContain('--path PATH --zone ID')
    expect(help[0]!.stdout).toContain('actual File Region')
    expect(help[1]!.stdout).toContain('--region ID')
    expect(help[1]!.stdout).toContain('source|diff|preview')
    expect(fixture.seen).toHaveLength(before); noByteOrTextRead(); fixture.noLifecycle()
    receipts.push({ discovery: help.map(item => item.stdout), serverCalls: 0 })
  })
})

afterEach(async () => {
  const output = process.env.EDITOR_PUBLIC_RECEIPT
  if (output) { await mkdir(join(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify({ scope: 'Actual compiled CLI and typed SDK → Unix JSON-RPC → original Desktop Store and hidden File consumer. Does not claim decoder readiness.', receipts }, null, 2)) }
})
