import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build as bundle } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionHelperStore, type AgentExecutionHelperRecord } from '../src/agent-execution-helper-store.js'
import type { AgentExecutionHelperInput, AgentExecutionHelperPreparation } from '../src/agent-execution-helper.js'
import * as durable from '../src/durable-write.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'execution-store-')); roots.push(root)
  const input: AgentExecutionHelperInput = { bindingId: 'original-binding', role: 'frontend', providerId: 'codex', workspacePath: root, createOperationId: 'original-create' }
  return { root, input, store: new AgentExecutionHelperStore(root) }
}
function prepared(input: AgentExecutionHelperInput, marker = 'first'): AgentExecutionHelperPreparation {
  return { bindingId: input.bindingId, role: input.role, providerId: input.providerId, ...(input.role === 'executor' ? { journalIdentity: 'original-executor-journal' } : {}), prepared: { createOperationId: input.createOperationId, workspacePath: input.workspacePath,
    launch: JSON.stringify({ createOperationId: input.createOperationId, request: { program: process.execPath, args: [marker], cwd: input.workspacePath, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: input.createOperationId, PRIVATE_FIXTURE: 'never-in-diagnostics' }, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) } }
}
const pathFor = (root: string, input: AgentExecutionHelperInput) => join(root, 'execution-helpers', createHash('sha256').update(JSON.stringify([input.bindingId, input.role])).digest('hex') + '.json')

it('retains the exact original private preparation across store instances without rebuilding', async () => {
  const f = await fixture(), original = prepared(f.input), build = vi.fn(async () => original)
  expect(await f.store.read(f.input.bindingId, f.input.role)).toBeNull()
  const first = await f.store.prepare(f.input, build)
  first.prepared.launch = 'caller mutation'
  const reopened = new AgentExecutionHelperStore(f.root)
  expect(await reopened.prepare(f.input, build)).toEqual(original)
  expect(await reopened.read(f.input.bindingId, f.input.role)).toEqual({ input: f.input, preparation: original })
  expect(build).toHaveBeenCalledTimes(1)
  const path = pathFor(f.root, f.input)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(path + '.lock')).mode & 0o777).toBe(0o600)
  expect((await stat(join(f.root, 'execution-helpers'))).mode & 0o777).toBe(0o700)
})

it('singleflights same-key preparations across instances and preserves independent roles', async () => {
  const f = await fixture(), second = new AgentExecutionHelperStore(f.root)
  let release!: () => void
  const pending = new Promise<void>(resolvePending => { release = resolvePending })
  const build = vi.fn(async () => { await pending; return prepared(f.input) })
  const one = f.store.prepare(f.input, build), two = second.prepare(f.input, build)
  await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
  await expect(second.prepare({ ...f.input, createOperationId: 'conflict' }, build)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_CONFLICT' })
  const executor = { ...f.input, role: 'executor' as const, grant: { scope: 'host-user' as const, bindingId: f.input.bindingId } }
  await expect(second.prepare(executor, async () => prepared(executor))).resolves.toMatchObject({ role: 'executor' })
  release()
  expect(await one).toEqual(await two)
  expect(build).toHaveBeenCalledTimes(1)
})

it.each(['providerId', 'workspacePath', 'createOperationId', 'grant'] as const)('refuses a changed original %s without touching retained bytes', async field => {
  const f = await fixture()
  await f.store.prepare(f.input, async () => prepared(f.input))
  const path = pathFor(f.root, f.input), original = await readFile(path)
  const changed = { ...f.input, [field]: field === 'workspacePath' ? '/other-workspace' : field === 'grant' ? { scope: 'host-user', bindingId: f.input.bindingId } : 'another' }
  const build = vi.fn(async () => prepared(f.input))
  await expect(f.store.prepare(changed as AgentExecutionHelperInput, build)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_CONFLICT' })
  expect(build).not.toHaveBeenCalled()
  expect(await readFile(path)).toEqual(original)
})

it('refuses corrupt retained material without printing private data or rebuilding', async () => {
  const f = await fixture(); await f.store.prepare(f.input, async () => prepared(f.input))
  await writeFile(pathFor(f.root, f.input), '{never-in-diagnostics')
  const build = vi.fn(async () => prepared(f.input))
  await expect(f.store.prepare(f.input, build)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED' })
  try { await f.store.read(f.input.bindingId, f.input.role) } catch (error) { expect(String(error)).not.toContain('never-in-diagnostics') }
  expect(build).not.toHaveBeenCalled()
})

it('validates the original prepared terminal and rejects an identity mismatch before retention', async () => {
  const f = await fixture(), wrong = prepared(f.input)
  wrong.prepared.workspacePath = '/other'
  await expect(f.store.prepare(f.input, async () => wrong)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED' })
  expect(await f.store.read(f.input.bindingId, f.input.role)).toBeNull()
  expect((await readdir(join(f.root, 'execution-helpers'))).filter(name => name.endsWith('.json'))).toEqual([])
})

it('does not acknowledge preparation before durable write, and reuses a record after a lost write acknowledgement', async () => {
  const f = await fixture(), write = durable.durableWriteFile
  let release!: () => void
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  vi.spyOn(durable, 'durableWriteFile').mockImplementationOnce(async (...args) => { await gate; await write(...args); throw new Error('lost acknowledgement') })
  let settled = false
  const result = f.store.prepare(f.input, async () => prepared(f.input)).finally(() => { settled = true })
  const rejected = expect(result).rejects.toThrow('lost acknowledgement')
  await vi.waitFor(() => expect(durable.durableWriteFile).toHaveBeenCalledTimes(1))
  expect(settled).toBe(false)
  release(); await rejected
  const build = vi.fn(async () => prepared(f.input, 'wrong replacement'))
  expect(await f.store.prepare(f.input, build)).toEqual(prepared(f.input))
  expect(build).not.toHaveBeenCalled()
})

it('serializes actual independent Node writers with the native file lock', async () => {
  const f = await fixture(), worker = join(f.root, 'worker.mjs'), counter = join(f.root, 'builds')
  await symlink(resolve('packages/core/node_modules'), join(f.root, 'node_modules'), 'dir')
  const source = `import {AgentExecutionHelperStore} from ${JSON.stringify(resolve('packages/core/src/agent-execution-helper-store.ts'))};
import {appendFile} from 'node:fs/promises'; import {createHash,randomUUID} from 'node:crypto';
const input=JSON.parse(process.argv[3]), store=new AgentExecutionHelperStore(process.argv[2]);
const result=await store.prepare(input,async()=>{await appendFile(process.argv[4],'build\\n');await new Promise(r=>setTimeout(r,80));return {bindingId:input.bindingId,role:input.role,providerId:input.providerId,prepared:{createOperationId:input.createOperationId,workspacePath:input.workspacePath,launch:JSON.stringify({createOperationId:input.createOperationId,request:{program:process.execPath,args:[randomUUID()],cwd:input.workspacePath,env:{AGENTMUX_LIFECYCLE_OPERATION_ID:input.createOperationId},initial_size:{cols:80,rows:24},declared_inputs:[]}})}}});
process.stdout.write(createHash('sha256').update(result.prepared.launch).digest('hex'));`
  const identityRequire = createRequire(join(await realpath('packages/core/node_modules/@agentmux/identity'), 'package.json'))
  await bundle({ stdin: { contents: source, resolveDir: process.cwd() }, outfile: worker, bundle: true, platform: 'node', format: 'esm', alias: {
    '@agentmux/identity': resolve('packages/identity/src/index.ts'), '@noble/hashes/sha2.js': identityRequire.resolve('@noble/hashes/sha2.js'), '@scure/base': identityRequire.resolve('@scure/base'),
  }, logLevel: 'silent' })
  const run = () => new Promise<string>((resolveRun, reject) => {
    const child = spawn(process.execPath, [worker, f.root, JSON.stringify(f.input), counter], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { errors += bytes })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveRun(output) : reject(new Error(`Private store worker failed: ${errors}`)))
  })
  const [one, two] = await Promise.all([run(), run()])
  expect(one).toMatch(/^[a-f0-9]{64}$/u)
  expect(two).toBe(one)
  expect(await readFile(counter, 'utf8')).toBe('build\n')
})

it('requires an explicit state root and rejects foreign grants', async () => {
  expect(() => new AgentExecutionHelperStore('relative')).toThrow('absolute')
  const f = await fixture()
  await expect(f.store.prepare({ ...f.input, grant: { scope: 'host-user', bindingId: 'other' } }, async () => prepared(f.input))).rejects.toMatchObject({ code: 'INVALID_EXECUTION_HELPER' })
})

it('pins only the first original frontend receipt and returns it privately across reopen', async () => {
  const f = await fixture(), original = prepared(f.input)
  await f.store.prepare(f.input, async () => original)
  const pin = { runId: 'original-run', ownerInstanceId: 'original-owner', url: 'ws://127.0.0.1:34567/private-capability' }
  const build = vi.fn(async (record: AgentExecutionHelperRecord) => { expect(record).toEqual({ input: f.input, preparation: original }); return pin })
  const [one, two] = await Promise.all([f.store.pinFrontend(f.input.bindingId, build), new AgentExecutionHelperStore(f.root).pinFrontend(f.input.bindingId, build)])
  expect(one).toEqual(pin); expect(two).toEqual(pin); expect(build).toHaveBeenCalledTimes(1)
  one.url = 'caller mutation'
  const wrong = vi.fn(async () => ({ ...pin, runId: 'replacement' }))
  expect(await new AgentExecutionHelperStore(f.root).pinFrontend(f.input.bindingId, wrong)).toEqual(pin)
  expect(wrong).not.toHaveBeenCalled()
  expect(await f.store.read(f.input.bindingId, 'frontend')).toEqual({ input: f.input, preparation: original, frontend: pin })
  await f.store.prepare(f.input, async () => original)
  expect((await f.store.read(f.input.bindingId, 'frontend'))?.frontend).toEqual(pin)
})

it('does not create an endpoint without the original preparation or retain an invalid capability URL', async () => {
  const f = await fixture(), build = vi.fn(async () => ({ runId: 'run', ownerInstanceId: 'owner', url: 'ws://192.0.2.1:3456/private' }))
  await expect(f.store.pinFrontend(f.input.bindingId, build)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED' })
  expect(build).not.toHaveBeenCalled()
  await f.store.prepare(f.input, async () => prepared(f.input))
  await expect(f.store.pinFrontend(f.input.bindingId, build)).rejects.toMatchObject({ code: 'INVALID_EXECUTION_HELPER' })
  expect((await f.store.read(f.input.bindingId, 'frontend'))?.frontend).toBeUndefined()
})

it('retains the exact resource Host/runtime/workspace and refuses replacement on the same frontend binding', async () => {
  const f = await fixture()
  f.input.toolExecution = { bindingId: f.input.bindingId, resourceHostId: 'resource-host', resourceRuntimeId: 'resource-runtime', workspacePath: '/resource/project' }
  await f.store.prepare(f.input, async () => prepared(f.input))
  expect((await new AgentExecutionHelperStore(f.root).read(f.input.bindingId, 'frontend'))?.input.toolExecution).toEqual(f.input.toolExecution)
  const build = vi.fn(async () => prepared(f.input))
  for (const field of ['resourceHostId', 'resourceRuntimeId', 'workspacePath'] as const) {
    await expect(f.store.prepare({ ...f.input, toolExecution: { ...f.input.toolExecution, [field]: 'other-resource' } }, build)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_CONFLICT' })
  }
  await expect(f.store.prepare({ ...f.input, toolExecution: { ...f.input.toolExecution, bindingId: 'foreign-binding' } }, build)).rejects.toMatchObject({ code: 'INVALID_EXECUTION_HELPER' })
  await expect(f.store.prepare({ ...f.input, toolExecution: { ...f.input.toolExecution, resourceRuntimeId: '' } }, build)).rejects.toMatchObject({ code: 'INVALID_EXECUTION_BINDING' })
  expect(build).not.toHaveBeenCalled()
})

it('binds the original frontend preparation to its exact Agent Session', async () => {
  const f = await fixture(), input = { ...f.input, agentSessionId: 'original-agent' }
  await f.store.prepare(input, async () => prepared(input))
  expect((await new AgentExecutionHelperStore(f.root).read(input.bindingId, 'frontend'))?.input).toMatchObject({ agentSessionId: 'original-agent' })
  const build = vi.fn(async () => prepared(input))
  await expect(f.store.prepare({ ...input, agentSessionId: 'another-agent' }, build)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_CONFLICT' })
  expect(build).not.toHaveBeenCalled()
})

it('retains executor journal identity privately and refuses a journal-less or frontend receipt', async () => {
  const f = await fixture(), input = { ...f.input, role: 'executor' as const, grant: { scope: 'host-user' as const, bindingId: f.input.bindingId } }
  const original = prepared(input)
  await f.store.prepare(input, async () => original)
  const reopened = new AgentExecutionHelperStore(f.root)
  expect((await reopened.read(input.bindingId, 'executor'))?.preparation.journalIdentity).toBe('original-executor-journal')
  expect((await reopened.prepare(input, async () => ({ ...original, journalIdentity: 'replacement' }))).journalIdentity).toBe('original-executor-journal')
  const withoutIdentity = { ...original }; delete withoutIdentity.journalIdentity
  const other = { ...input, bindingId: 'other', grant: { ...input.grant, bindingId: 'other' } }
  await expect(f.store.prepare(other, async () => ({ ...withoutIdentity, bindingId: 'other' }))).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED' })
  await expect(f.store.prepare(f.input, async () => ({ ...prepared(f.input), journalIdentity: 'unexpected' }))).rejects.toMatchObject({ code: 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED' })
})
