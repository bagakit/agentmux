import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, open, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// A disposable real Native + semantic Host. It never discovers or adopts live
// Sessions. The caller supplies a newly allocated private root and artifact.
const [action, configurationPath] = process.argv.slice(2)
const config = JSON.parse(await readFile(configurationPath, 'utf8'))
const root = resolve(config.root), token = config.token
assert.ok(root.includes('/amx-goal-cross-host-') && typeof token === 'string' && token.length > 20)
const marker = join(root, 'private-owner.json'), manifestPath = join(root, 'processes.json')
const state = join(root, 's'), runtime = join(root, 'r'), store = join(state, 'sessions.json'), hostConfig = join(root, 'configuration.json')
const artifact = resolve(config.artifact), host = join(artifact, 'node_modules/@agentmux/host')
const corePath = join(host, 'node_modules/@agentmux/core'), hostEntry = join(host, 'dist/index.js')
const core = await import(pathToFileURL(join(corePath, 'dist/index.js')).href)
const node = config.nodePath, native = config.nativePath ?? join(corePath, 'vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
const socket = join(runtime, 'control.sock')
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|CODEX_)/u.test(key))),
  HOME: join(root, 'home'), CODEX_HOME: join(root, 'home/.codex'),
  AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state, AGENTMUX_AGENT_SESSION_STORE: store,
  AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'), AGENTMUX_HOST_CONFIGURATION_PATH: hostConfig,
  AGENTMUX_MOTE_CONFIGURATION_PATH: hostConfig, AGENTMUX_CONNECTOR_DIRECTORY: join(root, 'connections'),
  AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'absent-mobile') }
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const until = async (read, accept, label, timeout = 30_000) => {
  const end = Date.now() + timeout
  do { const value = await read(); if (accept(value)) return value; await new Promise(yes => setTimeout(yes, 30)) } while (Date.now() < end)
  throw Error('The private real Host did not confirm: ' + label)
}
const load = async () => { assert.equal(JSON.parse(await readFile(marker, 'utf8')).token, token); return JSON.parse(await readFile(manifestPath, 'utf8')) }
const save = value => writeFile(manifestPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const connect = async () => {
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  const identity = (await rpc.call('runtime.owner.identity', {})).owner
  const sdk = await core.connectHostedAgentMux({ rpc, expectedRuntimeId: identity.runtimeId,
    forwardRpc: (method, params, context) => rpc.call(method, params, context) })
  return { rpc, sdk, identity, close: async () => { await sdk.dispose(); await rpc.dispose() } }
}
async function launchHost(manifest) {
  const stdoutPath = join(root, 'host.stdout'), stderrPath = join(root, 'host.stderr')
  const stdout = await open(stdoutPath, 'w', 0o600), stderr = await open(stderrPath, 'a', 0o600)
  try {
    const child = spawn(node, [hostEntry, '--store', store], { cwd: root, env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] })
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no) })
    manifest.hostPid = child.pid; await save(manifest); child.unref()
  } finally { await stdout.close(); await stderr.close() }
  const published = await until(async () => {
    const lines = (await readFile(stdoutPath, 'utf8').catch(() => '')).split('\n')
    for (const line of lines) try { const value = JSON.parse(line); if (value.protocol === 'jsonrpc-2.0') return value } catch {}
    return null
  }, value => value?.owner, 'actual semantic owner publication')
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  try {
    published.owner = await until(async () => (await rpc.call('runtime.owner.identity', {})).owner, value => Boolean(value.ctxmux), 'actual Native identity from its public owner')
  } finally { await rpc.dispose() }
  manifest.owner = published.owner; await save(manifest); return published
}
async function terminate(pid) {
  if (!pid) return { pid, absent: true }
  let command
  try { command = (await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command='])).stdout }
  catch (error) { if (error.code === 1) return { pid, absent: true }; throw error }
  assert.ok(command.includes(root), 'A reused or unconfirmed PID is retained; never signal an unrelated process')
  process.kill(pid, 'SIGTERM')
  await until(async () => {
    try { const value = (await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat='])).stdout.trim(); return !value || value.startsWith('Z') }
    catch (error) { if (error.code === 1) return true; throw error }
  }, Boolean, 'owned process exit')
  return { pid, stopped: true }
}
let input = ''
for await (const chunk of process.stdin) input += chunk
const request = input.trim() ? JSON.parse(input) : {}
let result
if (action === 'start') {
  for (const directory of [state, runtime, join(state, 'ctxmux'), join(root, 'home/.codex'), join(root, 'connections'), join(root, 'workspace'), join(root, 'bin')]) await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(marker, JSON.stringify({ token, kind: 'disposable-goal-cross-host' }), { mode: 0o600, flag: 'wx' })
  await access(hostEntry); await access(join(corePath, 'dist/agentmux.js')); await access(native)
  const executor = join(root, 'workspace/provider.mjs'), provider = resolve(config.providerPath)
  await writeFile(executor, '#!' + node + '\nif(process.argv.includes("--version")){console.log("Private native fixture");process.exit(0)}\nawait import(' + JSON.stringify(pathToFileURL(provider).href) + ');\n', { mode: 0o700 })
  await writeFile(hostConfig, JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: config.label }, ...(config.peer ? [config.peer] : [])],
    executors: { codex: { label: 'Private native fixture', providerId: 'codex', command: executor, args: [], injectAgentMuxGuide: false } },
    workspaces: [{ id: 'private-workspace', name: 'Private original work', hostId: 'local', path: join(root, 'workspace'), kind: 'folder' }], appearance: {} }), { mode: 0o600 })
  const exports = Object.entries(env).filter(([key]) => /^(AGENTMUX_|CTXMUX_|CODEX_)/u.test(key)).map(([key, value]) => 'export ' + key + '=' + quote(value)).join('\n')
  await writeFile(join(root, 'bin/amux'), '#!/bin/sh\n' + exports + '\nexec ' + quote(node) + ' ' + quote(join(corePath, 'bin/amux')) + ' "$@"\n', { mode: 0o700 })
  const manifest = { token, nativePid: null, hostPid: null, roles: {}, owner: null }
  await save(manifest)
  const errorFile = await open(join(root, 'native.stderr'), 'a', 0o600)
  try {
    const child = spawn(native, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { cwd: root, env, detached: true, stdio: ['ignore', 'ignore', errorFile.fd, 'pipe'] })
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no) })
    manifest.nativePid = child.pid; await save(manifest)
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(Error('The private official Native readiness timed out')), 25_000)
      child.stdio[3].once('data', () => { clearTimeout(timer); yes() }); child.once('exit', code => { clearTimeout(timer); no(Error('Private Native exited before readiness: ' + code)) })
    })
    child.stdio[3].destroy(); child.unref()
  } finally { await errorFile.close() }
  const published = await launchHost(manifest), connection = await connect()
  try {
    for (const role of config.roles) {
      const credentialPath = join(root, role + '-credential.json')
      const created = await connection.sdk.createAgent({ providerId: 'codex', executorId: 'codex', createOperationId: 'private-' + role,
        workspacePath: join(root, 'workspace'), commandOverride: executor, args: [], injectAgentMuxGuide: false,
        env: { CODEX_HOME: env.CODEX_HOME, AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_PRESERVE: '1',
          AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(root, 'native'), AGENTMUX_FAKE_CAPABILITY_RECEIPT: credentialPath } })
      manifest.roles[role] = { agentSessionId: created.agentSessionId, run: created.run, credentialPath }; await save(manifest)
      await until(async () => connection.sdk.statusAgent(created.agentSessionId), value => value.run.state === 'running' && value.session.nativeHandle && value.session.terminalPromptReadiness?.readyThroughByte !== undefined, 'actual original Provider hook and ready frame')
    }
    result = { ...published, root, socketPath: socket, nativePid: manifest.nativePid, node: { version: process.version, platform: process.platform, architecture: process.arch }, nativeSHA256: createHash('sha256').update(await readFile(native)).digest('hex'), roles: Object.fromEntries(Object.entries(manifest.roles).map(([role, value]) => [role, { agentSessionId: value.agentSessionId, run: value.run }])) }
  } finally { await connection.close() }
} else if (action === 'cli') {
  const manifest = await load(), role = request.role
  const caller = role ? JSON.parse(await readFile(manifest.roles[role].credentialPath, 'utf8')) : null
  const resultEnv = { ...env, ...(caller ? { AGENTMUX_AGENT_SESSION_ID: caller.agentSessionId, AGENTMUX_AGENT_CAPABILITY: caller.capability } : {}) }
  result = await new Promise((yes, no) => {
    const child = spawn(node, [join(corePath, 'bin/amux'), '--endpoint', 'unix:' + socket, ...request.args], { cwd: join(root, 'workspace'), env: resultEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('The private original CLI exceeded its deadline')) }, 30_000)
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', error => { clearTimeout(timer); no(error) }); child.once('close', code => { clearTimeout(timer); yes({ code, stdout, stderr }) })
    child.stdin.end(request.body === undefined ? '' : JSON.stringify(request.body))
  })
} else if (action === 'restart-host') {
  const manifest = await load(); await terminate(manifest.hostPid); result = await launchHost(manifest)
} else if (action === 'cleanup') {
  const manifest = await load(), stopped = [], connection = await connect().catch(() => null)
  try {
    if (connection) for (const value of Object.values(manifest.roles)) { const receipt = await connection.sdk.stopAgent(value.agentSessionId, value.run); stopped.push({ agentSessionId: value.agentSessionId, run: value.run, receipt }) }
    else assert.equal(Object.keys(manifest.roles).length, 0, 'Retain private data when original Agent termination is unconfirmed')
  } finally { await connection?.close() }
  const host = await terminate(manifest.hostPid), native = await terminate(manifest.nativePid)
  result = { schema: 'agentmux.goal-cross-host-private-cleanup.v1', stopped, host, native, tokenMatched: true,
    diagnostics: { host: (await readFile(join(root, 'host.stderr'), 'utf8').catch(() => '')).slice(-16000), native: (await readFile(join(root, 'native.stderr'), 'utf8').catch(() => '')).slice(-16000) } }
  await writeFile(join(root, 'cleanup.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
} else if (action === 'check') {
  await load()
  const checks = join(root, 'workspace/checks'); await mkdir(checks, { recursive: true })
  await writeFile(join(checks, 'worker.json'), JSON.stringify(request.worker))
  await writeFile(join(checks, 'received.json'), JSON.stringify(request.received))
  await writeFile(join(checks, 'original.test.mjs'), `import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';test('remote original report retained its exact signature and application',()=>{const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));const worker=read('./worker.json'),received=read('./received.json');assert.deepEqual(received.provenance,worker.provenance);assert.deepEqual(received.envelope.application,worker.envelope.application);assert.equal(received.envelope.replyTo,${JSON.stringify(request.sourceMessageId)});});\n`)
  const checked = await promisify(execFile)(node, ['--test', 'checks/original.test.mjs'], { cwd: join(root, 'workspace'), env })
  await writeFile(join(checks, 'review.log'), checked.stdout + checked.stderr)
  result = { command: 'node --test checks/original.test.mjs', result: checked.stdout, evidence: ['checks/review.log:1'] }
} else throw Error('Select start, cli, restart-host, check or cleanup for this original private root.')
process.stdout.write(JSON.stringify(result) + '\n')
