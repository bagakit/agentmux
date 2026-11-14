import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agent, cleanup, hostFixture } from './helpers/file-path-fixture.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { FileMutationObservations } from '../src/file-mutation-observations.js'
import { FilePathMutations } from '../src/file-path-mutations.js'
import type { FileMutationEffect } from '@agentmux/core/files'

afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function watch(f: Awaited<ReturnType<typeof hostFixture>>, path = '.') {
  const params = { zoneId: 'original-files-zone', path, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const frames: any[] = [], child = spawn(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + join(f.original.root, 'host.sock'), 'file', 'mutation', 'watch', '--input', '-'],
    { env: objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability }), stdio: ['pipe', 'pipe', 'pipe'] })
  let pending = '', stderr = '', exit: number | null | undefined
  const closed = new Promise<void>(yes => child.once('close', code => { exit = code; yes() }))
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    pending += chunk
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) frames.push(JSON.parse(line)) }
  })
  child.stdin.end(JSON.stringify(params))
  cleanup.push(async () => { if (exit === undefined) child.kill('SIGINT'); await closed })
  await vi.waitFor(() => { expect(exit, JSON.stringify(frames) + stderr).toBeUndefined(); expect(frames[0]?.result?.initial?.delivery, JSON.stringify(frames) + stderr).toBe('live-only') }, { timeout: 10000 })
  return { frames, effects: () => frames.flatMap(frame => frame.params?.event?.type === 'effect' ? [frame.params.event.data] : []), close: async () => { child.kill('SIGINT'); await closed; expect(exit).toBe(0) } }
}

it('compiled watch consumes actual Host/Native positive effects, distinguishes no-OP creation and filters another managed actor without replay', async () => {
  const f = await hostFixture(), observer = await watch(f), subtree = await watch(f, 'original')
  const stat = async (path: string) => (await f.cli(['stat'], { zoneId: 'original-files-zone', path, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })).body.result
  const mkdir = async (path: string, operationId: string, who = agent.actor.id) => {
    const seen = await stat(path), input = { zoneId: 'original-files-zone', path, operationId, expectedResource: seen.resource, expectedAbsent: true, expected: { root: seen.result.observation.root, parent: seen.result.observation.parent } }
    const reply = await f.cli(['mkdir'], input, who)
    expect(reply.code, reply.stdout + reply.stderr).toBe(0); expect(reply.body.result.result.filesystem).toBe('created')
    return input
  }
  const original = await mkdir('original', 'original-live-mkdir')
  await vi.waitFor(() => expect(observer.effects()).toHaveLength(1))
  await f.cli(['mutation', 'inspect'], { zoneId: original.zoneId, path: original.path, operationId: original.operationId, expectedResource: original.expectedResource })
  await f.cli(['mkdir'], original)
  await mkdir('other', 'other-actor-live-mkdir', 'other-files-agent')
  const absent = await stat('created.txt')
  const create = await f.cli(['create'], { zoneId: 'original-files-zone', path: 'created.txt', expectedResource: absent.resource, content: 'Original live body', expectedRevision: null })
  expect(create.code, create.stdout + create.stderr).toBe(0)
  expect(create.body.result.result.status).toBe('written')
  const source = await stat('original'), destination = await stat('moved')
  const moveInput = { operationId: 'original-live-move', zoneId: 'original-files-zone', path: 'original', expectedResource: source.resource,
    expected: { root: source.result.observation.root, parent: source.result.observation.parent, entry: source.result.observation.entry },
    destination: { zoneId: 'original-files-zone', path: 'moved', expectedResource: destination.resource, expectedAbsent: true,
      expected: { root: destination.result.observation.root, parent: destination.result.observation.parent } } }
  const moved = await f.cli(['move'], moveInput)
  expect(moved.code, moved.stdout + moved.stderr).toBe(0); expect(moved.body.result.result.filesystem).toBe('moved')
  const remove = await stat('moved'), deletion = { operationId: 'original-live-delete', zoneId: 'original-files-zone', path: 'moved', expectedResource: remove.resource,
    expected: { root: remove.result.observation.root, parent: remove.result.observation.parent, entry: remove.result.observation.entry } }
  const deleted = await f.cli(['delete'], deletion)
  expect(deleted.code, deleted.stdout + deleted.stderr).toBe(0); expect(deleted.body.result.result.filesystem).toBe('deleted')
  await mkdir('last', 'last-live-mkdir')
  await vi.waitFor(() => expect(observer.effects()).toHaveLength(5))
  expect(observer.effects().map(value => [value.type, value.request?.operationId])).toEqual([
    ['path-mutation', original.operationId], ['created-file', undefined], ['path-mutation', moveInput.operationId], ['path-mutation', deletion.operationId], ['path-mutation', 'last-live-mkdir']
  ])
  expect(observer.effects()[0]).toMatchObject({ action: 'mkdir', request: original, receipt: { operationId: original.operationId, result: { filesystem: 'created' } } })
  expect(Object.keys(observer.effects()[1]).sort()).toEqual(['resource', 'revision', 'type'])
  await vi.waitFor(() => expect(subtree.effects()).toHaveLength(2))
  expect(subtree.effects().map(value => value.request.operationId)).toEqual([original.operationId, moveInput.operationId])
  expect(observer.effects()[2]).toMatchObject({ request: moveInput, receipt: moved.body.result })
  expect(observer.effects()[3]).toMatchObject({ request: deletion, receipt: deleted.body.result })
  await subtree.close()
  await observer.close()
  const after = await mkdir('after-cancel', 'after-watch-cancel')
  expect(after.operationId).toBe('after-watch-cancel')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('an actual Native producer never waits for a slow observer and terminates only that bounded reader once', async () => {
  const f = await hostFixture(), effects = new FileMutationObservations()
  const owner = new FilePathMutations({ directory: join(f.original.root, 'separate-mutation-records'), files: f.ordinary, effects, noteLease: work => work() })
  const controller = new AbortController(), received: FileMutationEffect[] = [], ended: Error[] = []
  let release!: () => void
  const held = new Promise<void>(yes => { release = yes })
  const observer = effects.subscribe(f.descriptor('.'), agent, event => { received.push(event); return held }, error => { if (error) ended.push(error) }, controller.signal)
  observer.start()
  const first = await owner.mkdir(f.workspace, await f.request('slow-first', 'slow-first-operation'), agent)
  expect(first.result.filesystem).toBe('created')
  await vi.waitFor(() => expect(received).toHaveLength(1))
  expect((await owner.mkdir(f.workspace, await f.request('slow-second', 'slow-second-operation'), agent)).result.filesystem).toBe('created')
  expect(ended).toHaveLength(1); expect(ended[0]).toMatchObject({ code: 'FILE_MUTATION_OBSERVATION_GAP' })
  expect((await owner.mkdir(f.workspace, await f.request('slow-third', 'slow-third-operation'), agent)).result.filesystem).toBe('created')
  expect(received).toHaveLength(1); expect(ended).toHaveLength(1)
  release(); controller.abort()
  await writeFile(join(f.root, 'ordinary-healthy.txt'), 'Original reads and writes remain healthy')
  expect((await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'ordinary-healthy.txt', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })).body.result.result.status).toBe('observed')
}, 30000)
