import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { OrdinaryWorkspaceFiles } from '../src/ordinary-files.js'
import { agent, cleanup, fixture, helper, hostFixture } from './helpers/file-path-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { cleanupExecutableNativeFixtures } from '../../../packages/core/test/helpers/executable-native-fixture.js'

const fault = vi.hoisted(() => ({ sync: '' }))
const facts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_FILE_PATH_ONCE_EVIDENCE) await writeFile(process.env.AGENTMUX_FILE_PATH_ONCE_EVIDENCE, JSON.stringify({ schema: 'agentmux.file-path-once-proof.v1', platform: process.platform, facts }, null, 2) + '\n') })
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (fault.sync === String(args[0])) { fault.sync = ''; throw Object.assign(new Error('Controlled original once-admission sync failed'), { code: 'EIO' }) }
      return sync()
    }
    return handle
  } }
})

beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve('apps/host/scripts/build-workspace-move-helper.mjs')]) })
afterEach(async () => { fault.sync = ''; await cleanupExecutableNativeFixtures(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('a real new Host/Core process observes the original once-admission after target and whole member namespace loss without a second mkdir', async () => {
  const f = await hostFixture(), query = { zoneId: 'original-files-zone', path: 'once-created', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const observed = (await f.cli(['stat'], query)).body.result
  const input = { ...query, operationId: 'whole-namespace-original', expectedResource: observed.resource, expectedAbsent: true,
    expected: { root: observed.result.observation.root, parent: observed.result.observation.parent } }
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  expect((await f.cli(['mkdir'], input)).body.result.result.filesystem).toBe('created')
  expect(native).toHaveBeenCalledTimes(1)
  await rm(join(f.root, input.path), { recursive: true }); await rm(join(f.original.root, 'file-path-mutations'), { recursive: true })
  await f.host.dispose()
  const bundle = resolve('apps/host/.local/file-path-host-reopen-' + process.pid + '.mjs')
  await mkdir(resolve('apps/host/.local'), { recursive: true })
  await build({ stdin: { resolveDir: process.cwd(), contents: "export {startAgentMuxHost} from './apps/host/src/host.ts';export {OrdinaryWorkspaceFiles} from './apps/host/src/ordinary-files.ts';export {AgentMuxClient,AgentMuxFileAgentSessionStore} from '@agentmux/core'" }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  cleanup.push(() => rm(bundle, { force: true }))
  const socket = join(f.original.root, 'reopened-new-core.sock'), configuration = join(f.original.root, 'reopened-host.json')
  await writeFile(configuration, JSON.stringify({ entry: bundle, stateDirectory: join(f.original.root, 'state'), runtimeDirectory: f.original.root,
    storePath: f.original.store.path, configurationPath: f.configurationPath, socketPath: socket, helper,
    desktopSocketPath: join(f.original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(f.original.root, 'absent-mobile') }))
  const child = spawn(process.execPath, [resolve('apps/host/test/helpers/file-path-host-reopen.mjs'), configuration], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk })
  cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)) } })
  const message = (type: string) => new Promise<Record<string, unknown>>((yes, no) => {
    const receive = (value: Record<string, unknown>) => { if (value.type === type) { child.off('message', receive); child.off('exit', exit); yes(value) } }
    const exit = (code: number | null) => { child.off('message', receive); no(new Error('Private reopened Core exited ' + code + ': ' + stderr)) }
    child.on('message', receive); child.once('exit', exit)
  })
  const ready = await message('ready'); expect(ready.pid).not.toBe(process.pid)
  const env = objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability })
  const cli = async (value: unknown, who = agent.actor.id, action = ['mkdir']) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socket, 'file', ...action, '--input', '-'], { ...env, AGENTMUX_AGENT_SESSION_ID: who }, JSON.stringify(value))
    return { ...result, body: result.stdout ? JSON.parse(result.stdout) : undefined }
  }
  const same = await cli(input)
  expect(same.code, same.stdout + same.stderr).toBe(0)
  expect(same.body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
  const stats = message('stats'); child.send({ type: 'stats' }); expect((await stats).mkdirCalls).toBe(0)
  await expect(readFile(join(f.root, input.path))).rejects.toMatchObject({ code: 'ENOENT' })
  const different = await cli({ ...input, path: 'other', expectedResource: { ...input.expectedResource, path: 'other' } })
  expect(different.code).toBe(1); expect(different.stdout + different.stderr).toContain('FILE_MUTATION_CONFLICT')
  const otherActor = await cli(input, 'other-files-agent')
  expect(otherActor.code).toBe(1); expect(otherActor.stdout + otherActor.stderr).toContain('FILE_MUTATION_CONFLICT')
  const inspect = await cli({ operationId: input.operationId, zoneId: input.zoneId, path: input.path, expectedResource: input.expectedResource }, 'other-files-agent', ['mutation', 'inspect'])
  expect(inspect.code).toBe(1); expect(inspect.stdout + inspect.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const next = await cli({ ...input, operationId: 'independent-after-namespace-loss', path: 'independent', expectedResource: { ...input.expectedResource, path: 'independent' } })
  expect(next.code, next.stdout + next.stderr).toBe(0)
  expect(next.body.result.result.filesystem).toBe('created')
  const healthy = message('stats'); child.send({ type: 'stats' }); expect((await healthy).mkdirCalls).toBe(1)
  child.send({ type: 'stop' }); await new Promise(resolve => child.once('close', resolve))
})

it('partial once-admission and its failed file/base acknowledgement never authorize a producer, while independent operations remain healthy', async () => {
  const f = await hostFixture(), query = { zoneId: 'original-files-zone', path: 'target', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const observed = (await f.cli(['stat'], query)).body.result
  const original = { ...query, operationId: 'partial-admission', expectedResource: observed.resource, expectedAbsent: true, expected: { root: observed.result.observation.root, parent: observed.result.observation.parent } }
  const marker = (operationId: string) => join(f.original.root, 'file-path-admission-' + createHash('sha256').update(operationId).digest('hex') + '.json')
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  await writeFile(marker(original.operationId), '')
  expect((await f.cli(['mkdir'], original)).body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
  expect(await readFile(marker(original.operationId), 'utf8')).toBe('')
  for (const [index, sync] of ['file', 'base'].entries()) {
    const input = { ...original, operationId: 'unconfirmed-admission-' + sync }
    fault.sync = index === 0 ? marker(input.operationId) : f.original.root
    expect((await f.cli(['mkdir'], input)).body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_PREPARE_UNCONFIRMED' })
    expect((await f.cli(['mkdir'], input)).body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
  }
  expect(native).not.toHaveBeenCalled()
  expect((await f.cli(['mkdir'], { ...original, operationId: 'independent-after-marker-failure' })).body.result.result.filesystem).toBe('created')
  expect(native).toHaveBeenCalledTimes(1)
})

it('the compiled move also keeps its original key after the whole member namespace disappears and its source is externally returned', async () => {
  const f = await hostFixture()
  await writeFile(join(f.root, 'source'), 'original move bytes')
  const query = { zoneId: 'original-files-zone', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const from = (await f.cli(['stat'], { ...query, path: 'source' })).body.result
  const to = (await f.cli(['stat'], { ...query, path: 'destination' })).body.result
  const input = { ...query, path: 'source', operationId: 'whole-namespace-original-move', expectedResource: from.resource,
    expected: { root: from.result.observation.root, parent: from.result.observation.parent, entry: from.result.observation.entry },
    destination: { ...query, path: 'destination', expectedResource: to.resource, expectedAbsent: true,
      expected: { root: to.result.observation.root, parent: to.result.observation.parent } } }
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'movePath')
  expect((await f.cli(['move'], input)).body.result.result.filesystem).toBe('moved')
  await rm(join(f.original.root, 'file-path-mutations'), { recursive: true })
  // This external reversal restores the same inode; it grants no replay of the old operation.
  await rename(join(f.root, 'destination'), join(f.root, 'source'))
  const replay = await f.cli(['move'], input)
  expect(replay.code, replay.stderr).toBe(0)
  expect(replay.body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
  expect(native).toHaveBeenCalledTimes(1)
  expect(await readFile(join(f.root, 'source'), 'utf8')).toBe('original move bytes')
  expect((await f.cli(['move'], { ...input, operationId: 'independent-move-after-namespace-loss' })).body.result.result.filesystem).toBe('moved')
  expect(native).toHaveBeenCalledTimes(2)
})

it('two real Files-owner processes admit only one Native producer for the same original key, and legacy complete records remain observation-only', async () => {
  const f = await fixture(), request = await f.request('race-target', 'same-key-first-publication')
  const bundle = resolve('apps/host/.local/file-path-admission-race-' + process.pid + '.mjs')
  await mkdir(resolve('apps/host/.local'), { recursive: true })
  await build({ stdin: { resolveDir: process.cwd(), contents: "export {FilePathMutations} from './apps/host/src/file-path-mutations.ts';export {OrdinaryWorkspaceFiles} from './apps/host/src/ordinary-files.ts'" }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  cleanup.push(() => rm(bundle, { force: true }))
  const configuration = join(f.original.root, 'admission-race.json')
  await writeFile(configuration, JSON.stringify({ entry: bundle, directory: join(f.original.root, 'file-path-mutations'), helper, workspace: f.workspace, request, actor: agent }))
  const children = [0, 1].map(() => spawn(process.execPath, [resolve('apps/host/test/helpers/file-path-admission-race.mjs'), configuration], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
  cleanup.push(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed } })
  await Promise.all(children.map(child => once(child, 'message')))
  const outputs = children.map(child => once(child, 'message'))
  const closed = children.map(child => once(child, 'close'))
  for (const child of children) child.send({ type: 'go' })
  const results = (await Promise.all(outputs)).map(([result]) => result as { type: string; nativeCalls: number; result: { result: { filesystem: string } } })
  await Promise.all(closed)
  expect(results.map(result => result.type)).toEqual(['result', 'result'])
  expect(results.reduce((sum, result) => sum + result.nativeCalls, 0)).toBe(1)
  expect(results.some(result => result.result.result.filesystem === 'created')).toBe(true)
  expect(await readdir(join(f.root, request.path))).toEqual([])
  const marker = join(f.original.root, 'file-path-admission-' + createHash('sha256').update(request.operationId).digest('hex') + '.json')
  await unlink(marker)
  const native = vi.spyOn(f.ordinary, 'mkdirPath')
  expect((await f.owner.mkdir(f.workspace, request, agent)).result).toMatchObject({ filesystem: 'created', durability: 'unconfirmed' })
  expect(native).not.toHaveBeenCalled()
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  facts.push({ case: 'cross-process-immutable-once-publication', processes: results, legacyCompleteRecordReadOnly: true })
})
