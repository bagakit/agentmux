import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { learningBehaviorFixture } from './agent-learning-behavior-fixture.js'
import { writeBehaviorTools } from './agent-learning-behavior-tools.mjs'

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
    const foreign = { ...input, zoneId: f.targets[1]!.zoneId }
    const writer = vi.spyOn(f.files, 'write')
    const rejected = await f.behaviorClient.call('file.write', { ...foreign, expectedResource: { ...read.resource, zoneId: foreign.zoneId }, expectedRevision: observed.result.document.revision, content: 'wrong target' }).catch(error => error)
    expect(writer, 'A wrong original resource must be refused before native file-save dispatch.').not.toHaveBeenCalled()
    expect(rejected).toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
    const untouched = await f.behaviorClient.call('file.read', f.resource(1, 'topic.md'))
    expect(untouched.result.status).toBe('read')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await f.closeBehavior() }
})

it('forwards the original file-write stdin bytes through the delegated shipping CLI while identity reads need no stdin', async () => {
  const f = await learningBehaviorFixture()
  try {
    const directory = join(f.root, 'private-tool-proof'); await mkdir(directory)
    const tools = await writeBehaviorTools({ directory, cliPath: resolve('packages/core/bin/amux'), endpoint: 'unix:' + join(f.root, 'behavior.sock'),
      caller: f.sourceCredentials.agentSessionId, capability: f.sourceCredentials.capability, operationId: 'tool-stdin-proof', production: 'Declared synthetic tool transport test.' })
    const call = (args: string[], body = '', keepStdinOpen = false) => new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
      const child = spawn(process.execPath, [tools.executable, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', value => { stdout += String(value) }); child.stderr.on('data', value => { stderr += String(value) })
      child.once('error', reject); child.once('close', code => accept({ code, stdout, stderr })); if (!keepStdinOpen) child.stdin.end(body)
    })
    const identity = await call(['whoami'])
    expect(identity.code, identity.stderr).toBe(0)
    expect(JSON.parse(identity.stdout).result.session.agentSessionId).toBe(f.sourceCredentials.agentSessionId)
    const help = await call(['file', 'write', '--help'], '', true)
    expect(help.code, help.stderr).toBe(0)
    const original = await f.behaviorClient.call('file.read', f.resource(0, 'MEMORY.md'))
    if (original.result.status !== 'read' || !original.resource) throw Error('Original memory unavailable.')
    const body = original.result.document.content + '\nLiteral proposed text: 中文 $HOME `shell text` $(not-a-command).\n\n'
    const saved = await call(['file', 'write', '--zone', f.targets[0]!.zoneId, '--path', 'MEMORY.md', '--resource', JSON.stringify(original.resource),
      '--expected-revision', original.result.document.revision], body)
    expect(saved.code, saved.stderr + saved.stdout).toBe(0)
    expect(JSON.parse(saved.stdout).result.result.status).toBe('written')
    const readback = await f.behaviorClient.call('file.read', f.resource(0, 'MEMORY.md'))
    expect(readback.result.status).toBe('read')
    if (readback.result.status === 'read') expect(readback.result.document.content).toBe(body)
    const query = JSON.stringify({ hostId: 'local', agentSessionId: 'source' })
    const listed = await call(['agent', 'learning', 'ls', '--input', '-'], query)
    expect(listed.code, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout).result.operations).toEqual([])
    const actions = (await readFile(join(directory, 'cli-actions.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(actions.map(row => row.stdin)).toEqual(['', '', body, query])
  } finally { await f.closeBehavior() }
})


it('binds complete delegated packets to their original independent Core creation', async () => {
  const evidence = await mkdtemp(join(tmpdir(), 'amx-learning-packet-'))
  const f = await learningBehaviorFixture(evidence)
  try {
    const operation = await f.prepare('packet-extraction')
    const extraction = await f.packet(operation, 'extraction', 'extraction')
    expect(extraction.fixtureCaller).toBe(operation.proposer.agentSessionId)
    expect(extraction.createOperationId).toBe(operation.proposer.createOperationId)
    const original = await f.store.readMetadata(operation.proposer.agentSessionId)
    expect(await readFile(join(evidence, 'extraction/production-input.txt'), 'utf8')).toBe(original!.initialInput!.prompt)
    const agentSessionId = 'packet-independent-session', createOperationId = 'packet-independent-create'
    const prepared = await f.topics.prepareAgent(f.workspace, f.targets[0]!.topicId, { providerId: 'codex', sessionId: agentSessionId })
    await f.core.createAgentWithDelivery({ agentSessionId, createOperationId, providerId: 'codex', executorId: 'saved',
      workspacePath: prepared.absolutePath, injectAgentMuxGuide: true, agentMuxNote: prepared.prompt, optionalContext: prepared.optionalContext,
      agentMuxTask: 'Read the current original knowledge without changing it.' })
    const later = await f.sessionPacket(agentSessionId, createOperationId, 'later')
    expect(later).toMatchObject({ stage: 'later', fixtureCaller: agentSessionId, operationId: createOperationId, createOperationId })
    expect(later.operationId).not.toBe(operation.operationId)
    const independent = await f.store.readMetadata(agentSessionId)
    expect(await readFile(join(evidence, 'later/production-input.txt'), 'utf8')).toBe(independent!.initialInput!.prompt)
    expect(JSON.parse(await readFile(join(evidence, 'later/initial-input.json'), 'utf8'))).toEqual(independent!.initialInput)
    await expect(f.sessionPacket(agentSessionId, operation.proposer.createOperationId, 'wrong-creation')).rejects.toThrow('another original Core creation')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await f.closeBehavior(); await rm(evidence, { recursive: true, force: true }) }
})
