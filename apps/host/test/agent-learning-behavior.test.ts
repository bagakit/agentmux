import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { learningBehaviorFixture } from './agent-learning-behavior-fixture.js'

vi.mock('electron', () => ({ nativeImage: {} }))
afterEach(() => vi.restoreAllMocks())

it('keeps original Scratch resource mapping, concurrent edits and unknown save distinct through the public Files owner', async () => {
  const f = await learningBehaviorFixture()
  try {
    expect(await readFile(join(f.catalog.spaces[0]!.directoryPath!, 'MEMORY.md'), 'utf8')).toBeTruthy()
    const input = f.resource(0, 'MEMORY.md'), read = await f.behaviorClient.call('file.read', input)
    expect(read.result.status, JSON.stringify(read)).toBe('read'); if (read.result.status !== 'read' || !read.resource) throw Error('Original memory unavailable.')
    expect(read.resource.workspacePath).toBe(f.workspace.path)
    expect(read.resource.zonePath).toBe(f.catalog.spaces[0]!.directoryPath)
    expect(read.resource.zonePath).not.toBe(read.resource.workspacePath)
    expect(read.resource.logicalDirectory).toBeTruthy()
    const original = read.result.document, retained = original.content + '\nUnrelated original user note.\n'
    const competitor = await f.competingFiles.write(f.workspace as never, { path: read.resource.path, content: retained, expectedRevision: original.revision })
    expect(competitor.status).toBe('written')
    const stale = await f.behaviorClient.call('file.write', { ...input, expectedResource: read.resource, expectedRevision: original.revision, content: 'stale replacement' })
    expect(stale.result.status).toBe('conflict')
    const current = await f.behaviorClient.call('file.read', input)
    expect(current.result.status).toBe('read'); if (current.result.status !== 'read') throw Error('Current original unavailable.')
    f.failNextSaveReceipt()
    const attempted = retained + '\nScoped method link.\n'
    const uncertain = await f.behaviorClient.call('file.write', { ...input, expectedResource: read.resource, expectedRevision: current.result.document.revision, content: attempted })
    expect(uncertain.result.status).toBe('unknown')
    const observed = await f.behaviorClient.call('file.read', input)
    expect(observed.result.status).toBe('read'); if (observed.result.status !== 'read') throw Error('Readback unavailable.')
    expect(observed.result.document.content).toBe(attempted)
    expect(uncertain.result.status).toBe('unknown') // Current bytes do not retroactively certify a lost receipt.
    expect(await readFile(join(f.catalog.spaces[0]!.directoryPath!, 'MEMORY.md'), 'utf8')).toBe(attempted)
    const foreign = { ...input, zoneId: f.targets[1]!.zoneId, spaceId: f.targets[1]!.spaceId }
    const writer = vi.spyOn(f.files, 'write')
    const rejected = await f.behaviorClient.call('file.write', { ...foreign, expectedResource: { ...read.resource, zoneId: foreign.zoneId }, expectedRevision: observed.result.document.revision, content: 'wrong target' }).catch(error => error)
    expect(writer, 'A wrong original resource must be refused before native file-save dispatch.').not.toHaveBeenCalled()
    expect(rejected).toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
    const untouched = await f.behaviorClient.call('file.read', f.resource(1, 'topic.md'))
    expect(untouched.result.status).toBe('read')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await f.closeBehavior() }
})
