import { afterEach, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { newNoteDocument, serializeNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('Mobile keeps original Files, Note history and Topic membership after Desktop exits and Host restarts', async () => {
  const f = await mobileWebFixture(); cleanup.push(f.close)
  const state = f.native.env.AGENTMUX_STATE_DIRECTORY!
  const configurationPath = join(state, 'original-configuration.json')
  const original = JSON.parse(await readFile(configurationPath, 'utf8'))
  const workspacePath = join(f.native.root, 'workspace')
  const scratch = join(f.native.root, 'scratch'), notes = join(f.native.env.HOME!, '.agentmux', 'notes')
  await Promise.all([mkdir(scratch), mkdir(workspacePath), mkdir(notes, { recursive: true })])
  await writeFile(configurationPath, JSON.stringify({ ...original, workspaces: [
    ...original.workspaces.map((value: any) => ({ ...value, path: workspacePath })), { id: '__scratch__', name: 'Topics', hostId: 'local', kind: 'folder', path: scratch },
    { id: '__notes__', name: 'Recall', hostId: 'local', kind: 'folder', path: notes }
  ] }))
  const spatial = new AgentMuxSpatialStateStore(join(state, 'spatial-state.json'))
  const spaceId = JSON.stringify(['local', notes]), zoneId = 'original-notes-zone'
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId, kind: 'folder', name: 'Recall', hostId: 'local', directoryPath: notes, projectId: null }],
    zones: [{ zoneId, workspaceId: '__notes__', kind: 'directory', hostId: 'local', directoryPath: notes, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {}
  } })
  const baseline = serializeNoteDocument(newNoteDocument('Original retained paragraph', 'original-note', 'original-block', 'Original title'))
  await writeFile(join(notes, 'original.note.md'), baseline)
  await writeFile(join(notes, 'plain.md'), 'Original ordinary file')
  await f.startMain()
  const existing = await f.relay()
  const ls = await existing.call('notebook.ls', {})
  await existing.call('notebook.apply', { expectedRevision: ls.state.revision, operationId: 'register-original-note',
    change: { kind: 'register', noteId: 'original-note', title: 'Original title', resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: notes, path: 'original.note.md' } } })
  await f.stopMain()
  const phone = await f.relay()
  const scope = { zoneId, expectedResource: { hostId: 'local', workspaceId: '__notes__', workspacePath: notes } }
  const plain = await phone.call('file.read', { ...scope, path: 'plain.md' }).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(plain).toMatchObject({ value: { result: { status: 'read', document: { content: 'Original ordinary file' } } } })
  const read = await phone.call('file.read', { ...scope, path: 'original.note.md' })
  expect(read.result.status).toBe('read'); if (read.result.status !== 'read' || !read.resource) throw Error('Original Note is not readable')
  const proposed = baseline.replace('Original retained paragraph', 'Mobile retained paragraph')
  const saved = await phone.call('file.write', { ...scope, path: 'original.note.md', expectedResource: read.resource,
    expectedRevision: read.result.document.revision, content: proposed, baseContent: baseline, operationId: 'mobile-note-edit' }).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  expect(saved).toMatchObject({ value: { result: { status: 'written', noteHistory: { status: 'committed', eventId: 'mobile-note-edit' } } } })
  const historyInput = { ...scope, path: 'original.note.md', expectedResource: read.resource, noteId: 'original-note', eventId: 'mobile-note-edit', includeContent: true }
  const history = await phone.call('file.history', historyInput)
  expect(JSON.stringify(history)).toContain('mobile-note-edit')
  expect(JSON.stringify(history)).toContain('Mobile retained paragraph')
  const inspected = await phone.call('notebook.inspect', { noteId: 'original-note', content: true })
  expect(inspected.content).toMatchObject({ noteId: 'original-note', status: 'read', content: expect.stringContaining('Mobile retained paragraph') })
  const shareSource = serializeNoteDocument(newNoteDocument('Original shared knowledge', 'sharing-source-note', 'sharing-source-block'))
  const shareDestination = serializeNoteDocument(newNoteDocument('Keep the ordinary mobile draft', 'sharing-destination-note', 'sharing-destination-block'))
  await writeFile(join(notes, 'sharing-source.note.md'), shareSource)
  await writeFile(join(notes, 'sharing-destination.note.md'), shareDestination)
  const request = async (path: string, operationId: string) => {
    const original = await phone.call('file.read', { ...scope, path })
    if (original.result.status !== 'read' || !original.resource) throw Error('Original sharing resource is unreadable')
    return { zoneId, path, expectedResource: original.resource, expectedRevision: original.result.document.revision,
      content: original.result.document.content, baseContent: original.result.document.content, operationId }
  }
  const sourceRequest = await request('sharing-source.note.md', 'sharing-source-edit')
  const destinationRequest = await request('sharing-destination.note.md', 'sharing-destination-save')
  const parsedDestination = readNoteDocument(destinationRequest.content)
  if (parsedDestination.status !== 'valid') throw Error('Original sharing destination is invalid')
  parsedDestination.note.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'mobile-shared-include', referenceId: 'mobile-shared-reference', noteId: 'mobile-shared-note', path: 'mobile-shared.note.md' } })
  expect(await phone.call('file.share', { operationId: 'mobile-share', destination: { ...destinationRequest, content: serializeNoteDocument(parsedDestination.note) }, promotions: [{
    operationId: 'mobile-promote', source: sourceRequest, sourceNoteId: 'sharing-source-note', sourceBlockId: 'sharing-source-block', referenceId: 'mobile-shared-reference',
    shared: { zoneId, path: 'mobile-shared.note.md', expectedResource: { ...sourceRequest.expectedResource, path: 'mobile-shared.note.md' }, noteId: 'mobile-shared-note' }
  }] })).toMatchObject({ status: 'committed' })
  const ambiguousRoot = join(f.native.root, 'ambiguous-notes'); await mkdir(ambiguousRoot)
  const ambiguousNote = newNoteDocument('Another original reference', 'ambiguous-note', 'ambiguous-block')
  ambiguousNote.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'ambiguous-include', referenceId: 'ambiguous-reference', noteId: 'mobile-shared-note', path: 'mobile-shared.note.md' } })
  await writeFile(join(ambiguousRoot, 'ambiguous.note.md'), serializeNoteDocument(ambiguousNote))
  const beforeAmbiguity = JSON.parse(await readFile(configurationPath, 'utf8'))
  await writeFile(configurationPath, JSON.stringify({ ...beforeAmbiguity, workspaces: [...beforeAmbiguity.workspaces, { id: null, hostId: 'local', path: ambiguousRoot }] }))
  const undo = await request('sharing-destination.note.md', 'mobile-share-undo')
  const parsedUndo = readNoteDocument(undo.content)
  if (parsedUndo.status !== 'valid') throw Error('Original shared undo destination is invalid')
  parsedUndo.note.content.content = parsedUndo.note.content.content!.filter(node => node.attrs?.referenceId !== 'mobile-shared-reference')
  expect(await phone.call('file.share.undo', { destination: { ...undo, content: serializeNoteDocument(parsedUndo.note) }, referenceIds: ['mobile-shared-reference'] })).toMatchObject({ status: 'committed', destination: { result: { status: 'written' } }, collections: [{ source: null, retainedReason: { code: 'scope-unconfirmed' } }] })
  expect(await readFile(join(notes, 'mobile-shared.note.md'), 'utf8')).toContain('Original shared knowledge')
  expect(await readFile(join(notes, 'sharing-source.note.md'), 'utf8')).toContain('::note-include')
  const decorated = JSON.parse(await readFile(configurationPath, 'utf8'))
  await writeFile(configurationPath, JSON.stringify({ ...decorated, executors: null, workspaces: decorated.workspaces.map((value: any) => value.id === 'original-workspace' ? { ...value, name: null } : value) }))
  expect((await phone.call('file.read', { ...scope, path: 'plain.md' })).result).toMatchObject({ status: 'read', document: { content: 'Original ordinary file' } })
  const categoryId = 'AbCdEfGh1234', topicId = 'BcDeFgHi2345'
  const category = await phone.call('topic.category.create', { categoryId, title: 'Mobile category' })
  const topic = await phone.call('topic.create', { topicId, categoryId, title: 'Original mobile topic' })
  expect(JSON.stringify(topic)).toContain(topicId)
  const after = await spatial.read()
  expect(after!.graph.bindings.some(binding => binding.spaceId === category.category.spaceId)).toBe(true)
  const beforeRun = f.session.run
  await f.native.restart()
  const fresh = await f.relay()
  expect((await fresh.call('notebook.inspect', { noteId: 'original-note', content: true })).content).toMatchObject({ status: 'read', content: expect.stringContaining('Mobile retained paragraph') })
  expect(JSON.stringify(await fresh.call('file.history', historyInput))).toContain('mobile-note-edit')
  expect(JSON.stringify(await fresh.call('topic.inspect', { topicId }))).toContain('Original mobile topic')
  expect((await spatial.read())!.graph.bindings).toEqual(after!.graph.bindings)
  const client = await f.native.client()
  expect((await client.readAgentSession(f.session.agentSessionId))!.run).toEqual(beforeRun)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'notebook', 'inspect', '--note', 'original-note', '--content'], f.native.env)
  expect(cli.code, cli.stderr).toBe(0); expect(cli.stdout).toContain('Mobile retained paragraph')
}, 90_000)
