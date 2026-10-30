// @vitest-environment happy-dom
import { testAppDocumentSources } from './helpers/app-document-fixture'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { WorkbenchDocumentSources } from '../src/main/workbench-document-sources'
import { assertAppDocumentSender } from '../src/main/ipc-sender-trust'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset() })

it('production preload and registered Main reject foreign native documents before private reads, writes and event owners', async () => {
  const f = await owningBridge(undefined, { filesWorkspace: true })
  const originalInvoke = bridge.invoke.getMockImplementation()!
  const read = vi.spyOn(WorkspaceFiles.prototype, 'read'), create = vi.spyOn(WorkspaceFiles.prototype, 'create')
  try {
    await writeFile(join(bridge.directory, 'original.txt'), 'Original private contents\n')
    const originalUrl = f.sender.mainFrame.url
    const event = { sender: f.sender, senderFrame: f.sender.mainFrame } as { sender: unknown; senderFrame: unknown }
    bridge.invoke.mockImplementation(async (channel, ...args) => {
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error('Missing production registration: ' + channel)
      return await handler(event, ...args)
    })
    const invalid = [
      () => { event.sender = {} },
      () => { event.senderFrame = {} },
      () => { event.senderFrame = null },
      () => { f.sender.mainFrame.detached = true },
      () => { f.sender.mainFrame.url = 'file:///unapproved/document.html' }
    ]
    expect(invalid).toHaveLength(5)
    for (const change of invalid) {
      event.sender = f.sender; event.senderFrame = f.sender.mainFrame
      f.sender.mainFrame.detached = false; f.sender.mainFrame.url = originalUrl
      change()
      await expect(bridge.api!.files.read('private-files', 'original.txt')).rejects.toThrow('Untrusted application')
      await expect(bridge.api!.files.create('private-files', { kind: 'file', path: 'never-created.txt' })).rejects.toThrow('Untrusted application')
      await expect(bridge.api!.ui.requestStorageFlush()).rejects.toThrow('Untrusted application')
    }
    expect(read).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled()
    await expect(access(join(bridge.directory, 'never-created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(bridge.directory, 'original.txt'), 'utf8')).toBe('Original private contents\n')
    f.sender.mainFrame.url = originalUrl; f.sender.mainFrame.detached = false
    bridge.invoke.mockImplementation(originalInvoke)
    expect(await bridge.api!.files.read('private-files', 'original.txt')).toMatchObject({ status: 'read', document: { content: 'Original private contents\n' } })
    await bridge.api!.files.create('private-files', { kind: 'file', path: 'created.txt' })
    expect(await readFile(join(bridge.directory, 'created.txt'), 'utf8')).toBe('')
    await bridge.api!.ui.requestStorageFlush()
    expect(read).toHaveBeenCalled(); expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'private-files' }), { kind: 'file', path: 'created.txt' })
    expect(f.flush).toHaveBeenCalledExactlyOnceWith()
  } finally { await f.dispose() }
  expect(bridge.handlers.size).toBe(0)
  const next = await owningBridge()
  try { expect(await bridge.api!.config.get()).toMatchObject({ executors: { private: { providerId: 'codex' } } }) }
  finally { await next.dispose() }
})

it('the original loader keeps the serving document across candidate loading, failure and rollback without URL self-authorization', () => {
  const sourceA = { mode: 'prod' as const, filePath: '/private/renderer-a/index.html' }
  const sourceB = { mode: 'prod' as const, filePath: '/private/renderer-b/index.html' }
  const documents = new WorkbenchDocumentSources()
  const frame = { url: 'file://' + sourceA.filePath, detached: false, isDestroyed: () => false }
  const contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame }
  const call = () => assertAppDocumentSender(event, contents, documents.read())
  const initial = documents.begin(sourceA)
  expect(call).not.toThrow() // A preload does not wait for Renderer ready.
  documents.committed(frame.url); initial()
  const failedBeforeCommit = documents.begin(sourceB)
  expect(call).not.toThrow() // A is still physically serving.
  failedBeforeCommit(); expect(call).not.toThrow()
  const candidate = documents.begin(sourceB)
  frame.url = 'file://' + sourceB.filePath
  expect(call).not.toThrow() // B's original early preload may precede did-navigate delivery.
  documents.committed(frame.url); candidate() // A ready timeout cannot revoke committed B.
  expect(call).not.toThrow()
  const rollback = documents.begin(sourceA)
  expect(call).not.toThrow() // B is retained until rollback actually commits.
  frame.url = 'file://' + sourceA.filePath
  documents.committed(frame.url); rollback()
  expect(call).not.toThrow()
  frame.url = 'file:///unapproved/changed.html'
  documents.committed(frame.url)
  expect(call).toThrow('Untrusted application')
  expect(documents.read()).toEqual({ current: sourceA, loading: null })
})


it('domain fixtures pin a private source and retain the original frame plus deliberately wrong facts', () => {
  const frame = {}, contents = { mainFrame: frame }, sources = testAppDocumentSources(contents)
  expect(contents.mainFrame).toBe(frame)
  expect(testAppDocumentSources(contents)).toBe(sources)
  expect(() => assertAppDocumentSender({ sender: contents, senderFrame: frame }, contents as never, sources())).not.toThrow()
  expect(() => assertAppDocumentSender({ sender: contents, senderFrame: {} }, contents as never, sources())).toThrow('Untrusted application')
  const foreign = { mainFrame: { url: 'file:///unapproved/current.html' } }, foreignSources = testAppDocumentSources(foreign)
  expect(() => assertAppDocumentSender({ sender: foreign, senderFrame: foreign.mainFrame }, foreign as never, foreignSources())).toThrow('Untrusted application')
  const missing = { mainFrame: undefined }, missingSources = testAppDocumentSources(missing)
  expect(missing.mainFrame).toBeUndefined()
  expect(() => assertAppDocumentSender({ sender: missing, senderFrame: undefined }, missing as never, missingSources())).toThrow('Untrusted application')
})
