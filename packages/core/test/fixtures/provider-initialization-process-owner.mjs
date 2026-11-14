import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [root, compiled] = process.argv.slice(2)
if (!root || !compiled) throw new Error('An exact private directory and compiled Core are required.')
const initialization = '@agentmux/providers/grok/input-initialization'
const initializationURL = import.meta.resolve(initialization)
const observedModules = new Set(['client.js', 'ctxmux-run-adapter.js', 'agent-native-process.js',
  initialization, 'agent-initialization.js', 'agent-input-receipt-codec.js'])
const mutation = process.env.AMX_SESSION_STATE_COMPILED_MUTATION
if (mutation && mutation !== 'additive-environment') throw new Error('Unknown compiled environment mutation.')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:')) return result
  const path = url === initializationURL ? initialization : relative(compiled, fileURLToPath(url))
  if (!observedModules.has(path)) return result
  const original = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
  let source = original
  if (mutation && path === 'ctxmux-run-adapter.js') {
    const anchor = 'const env = await nativeProcessEnvironment(run.pid, signal);'
    if (source.split(anchor).length !== 2) throw new Error('The compiled adapter environment mutation must match one actual implementation site.')
    source = source.replace(anchor, 'const env = run.spec ? { ...run.spec.env } : undefined;')
  }
  if (process.env.AMX_SESSION_STATE_COMPILED_LOADED) appendFileSync(process.env.AMX_SESSION_STATE_COMPILED_LOADED, JSON.stringify({
    path, originalSHA256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(source).digest('hex'),
    ...(original === source ? {} : { mutation })
  }) + '\n')
  return source === original ? result : { ...result, source }
} })

const nativeHome = join(root, 'native-original'), command = join(root, 'grok-native')
await mkdir(nativeHome)
await writeFile(join(nativeHome, 'config.json'), JSON.stringify({ cwd: root, projectTrusted: false }))
// A real private CLI process and its read-only protocol; no model or real credentials are involved.
await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
if(process.argv.slice(2).join(' ')==='inspect --json') {
  if(process.env.DAEMON_NATIVE_PROFILE!=='original-extra') process.exit(9);
  fs.writeFileSync(${JSON.stringify(join(root, 'inspection.json'))},JSON.stringify({home:process.env.GROK_HOME,profile:process.env.DAEMON_NATIVE_PROFILE}));
  process.stdout.write(fs.readFileSync(path.join(process.env.GROK_HOME,'config.json')));
} else {process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n');}\n`)
await chmod(command, 0o700)
const native = spawn(command, [], { env: { HOME: root, GROK_HOME: nativeHome, DAEMON_NATIVE_PROFILE: 'original-extra' }, stdio: ['pipe', 'pipe', 'pipe'] })
await once(native.stdout, 'data')
process.on('exit', () => { if (native.exitCode === null && native.signalCode === null) native.kill('SIGTERM') })

const load = name => import(pathToFileURL(join(compiled, name + '.js')).href)
const { AgentMuxClient } = await load('client')
const { AgentMuxFileAgentSessionStore } = await load('agent-session-store')
const { AgentMuxControlServer } = await load('public-rpc-server')
const id = 'initialization-original', runId = 'initialization-run-original'
const key = { kind: 'prompt', agentSessionId: id, expectedRun: { runId }, submissionId: 'initialization-query-original' }
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'grok', executorId: 'grok', hostId: 'local',
  workspacePath: root, run: { runId }, retiredRuns: [], hookBindingId: 'binding-original', hookToken: 'private-fixture-token',
  creation: { createOperationId: 'create-original', createdRun: { runId }, initialPrompt: 'not-requested' }, createdAt: 1, updatedAt: 1 })
const client = new AgentMuxClient({ store })
await client.registry.load('local'); client.connected = true
let runtimeWrites = 0
const originalRun = () => ({ id: runId, state: { type: 'running' }, spec: { program: command, args: [], cwd: root,
  // The daemon inherited native configuration beyond this deliberately additive override.
  env: { HOME: root } }, pid: native.pid, current_size: { cols: 80, rows: 24 }, latest_output_bytes: 0,
  first_available_byte: 0, applied_input_bytes: 0, native_service: null })
client.kernel.client = { status: async requested => {
  if (requested !== runId || native.exitCode !== null || native.signalCode !== null) throw new Error('The original private Run changed.')
  return originalRun()
} }
client.kernel.isConnected = () => true
client.kernel.input = async () => { runtimeWrites++; throw new Error('Initialization waiting cannot write Runtime input.') }
client.kernel.openInput = async () => { runtimeWrites++; throw new Error('Initialization waiting cannot open a Runtime input writer.') }
// status, readRunEnvironment and their original PID fences are the actual compiled adapter.
await client.submitAgentPrompt({ agentSessionId: id, expectedRun: key.expectedRun, operationId: key.submissionId,
  prompt: 'Original private query', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
await client.inputWaitingRecipients.get(id)?.pending
const input = await client.inspectAgentInput({ key })
const server = new AgentMuxControlServer({ socketPath: join(root, 'initialization.sock'), coreClients: () => [{ hostId: 'local', client }] })
await server.start()
let inspection = null
try { inspection = JSON.parse(await readFile(join(root, 'inspection.json'), 'utf8')) } catch { /* Absent only on a failed or mutated diagnostic. */ }
process.send?.({ type: 'ready', pid: process.pid, nativePid: native.pid, nativeAlive: native.exitCode === null && native.signalCode === null,
  endpoint: server.path, runtimeWrites, input, inspection, nativeHome, specEnv: originalRun().spec.env })
process.on('message', async message => {
  if (message?.type !== 'close') return
  try {
    await server.stop(); await client.dispose()
    if (native.exitCode === null && native.signalCode === null) { const exited = once(native, 'exit'); native.stdin.end(); await exited }
    process.exit(0)
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exit(1) }
})
