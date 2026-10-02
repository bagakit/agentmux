import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execute = promisify(execFile)
export const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

export async function readFarmInput(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 2); assert.equal(argv[0], '--input')
  const input = JSON.parse(await fs.readFile(argv[1], 'utf8'))
  assert.equal(input.schema, 'agentmux.remote-farm-input.v1')
  assert.equal(input.endpoint.transport, 'ssh')
  for (const field of ['expectedRuntimeId', 'agentSessionId', 'runId', 'remoteWorkspace', 'scopeRoot',
    'ownerControlPath', 'headlessLaunchPath', 'nodePath']) assert.ok(typeof input[field] === 'string' && input[field].length)
  assert.ok(Number.isSafeInteger(input.pid) && input.pid > 0)
  assert.ok(Number.isSafeInteger(input.nativePid) && input.nativePid > 0)
  assert.ok(Object.keys(input.packageIdentity.compiledCoreHashes).length > 0, 'Installed package identity must name actual compiled files')
  assert.ok(input.remoteWorkspace.startsWith(input.scopeRoot + '/'), 'The test workspace must belong to this exact private scope')
  for (const field of ['ownerControlPath', 'headlessLaunchPath']) assert.ok(input[field].startsWith(input.scopeRoot + '/'))
  return input
}

export async function ssh(input, argv, options = {}) {
  const endpoint = input.endpoint
  assert.ok(typeof endpoint.host === 'string' && endpoint.host && !/[\0\r\n]/u.test(endpoint.host))
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10']
  if (endpoint.identityFile) args.push('-i', endpoint.identityFile)
  if (endpoint.port) args.push('-p', String(endpoint.port))
  args.push('--', endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host, argv.map(quote).join(' '))
  return await execute('ssh', args, { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, ...options })
}

async function retainedProcesses(input, pids) {
  const { stdout } = await ssh(input, [input.nodePath, '--input-type=module', '-e',
    'import fs from "node:fs/promises";const out=[];for(const pid of JSON.parse(process.argv[1])){const raw=await fs.readFile(`/proc/${pid}/stat`,"utf8");const fields=raw.slice(raw.lastIndexOf(")")+2).trim().split(/\\s+/);process.kill(pid,0);out.push({pid,state:fields[0],startTime:fields[19]})}process.stdout.write(JSON.stringify(out))',
    JSON.stringify(pids)])
  const result = JSON.parse(stdout)
  assert.equal(result.length, pids.length)
  assert.ok(result.length > 0)
  for (let i = 0; i < result.length; i++) {
    assert.equal(result[i].pid, pids[i]); assert.match(result[i].startTime, /^\d+$/)
    assert.ok(!['Z', 'X', 'x'].includes(result[i].state), 'Retained processes are live, not zombies or dead processes')
  }
  return result
}

export async function ownerControl(input, operation, extraRetainedPids = []) {
  const action = operation === 'stop' ? 'shutdown' : operation === 'restart' ? 'serve' : 'status'
  const pids = [...new Set([input.pid, input.nativePid, ...extraRetainedPids].filter(pid => Number.isSafeInteger(pid) && pid > 0))]
  const before = operation === 'stop' ? await retainedProcesses(input, pids) : undefined
  const shutdown = String.raw`
import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
const [node, control, launch, expectedRuntimeId] = process.argv.slice(1), execute = promisify(execFile);
const invoke = async action => JSON.parse((await execute(node, [control, launch, action])).stdout);
const current = (await invoke('status')).result.owner;
assert.equal(current.runtimeId, expectedRuntimeId); assert.ok(Number.isSafeInteger(current.processId) && current.processId > 0);
const pid = current.processId, before = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
const startTime = raw => raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
const reply = await invoke('shutdown'), deadline = Date.now() + 15000;
let exitObserved;
while (Date.now() < deadline) {
  try { const raw = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    assert.equal(startTime(raw), startTime(before), 'The original owner PID cannot be replaced during shutdown proof');
    if (['Z', 'X', 'x'].includes(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0])) { exitObserved = 'exited'; break; }
  } catch (error) { if (error.code === 'ENOENT') { exitObserved = 'absent'; break; } throw error; }
  await new Promise(resolve => setTimeout(resolve, 20));
}
assert.ok(exitObserved, 'The exact current semantic owner must exit before outage output is triggered');
process.stdout.write(JSON.stringify({ shutdown: reply, exitedOwnerPid: pid, exitedOwnerInstanceId: current.ownerInstanceId, exitObserved }));
`
  const reply = operation === 'stop'
    ? await ssh(input, [input.nodePath, '--input-type=module', '-e', shutdown, input.nodePath, input.ownerControlPath, input.headlessLaunchPath, input.expectedRuntimeId])
    : await ssh(input, [input.nodePath, input.ownerControlPath, input.headlessLaunchPath, action])
  const result = JSON.parse(reply.stdout.trim())
  if (operation === 'stop') {
    const after = await retainedProcesses(input, pids)
    assert.deepEqual(after.map(item => [item.pid, item.startTime]), before.map(item => [item.pid, item.startTime]))
    return { stopped: true, receipt: result, retainedProcesses: after }
  }
  if (operation !== 'restart') return result
  assert.ok(Number.isSafeInteger(result.spawnedOwnerPid) && result.spawnedOwnerPid > 0)
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const { stdout } = await ssh(input, [input.nodePath, '--input-type=module', '-e',
      'import fs from "node:fs/promises";const lines=(await fs.readFile(process.argv[1],"utf8")).split("\\n");for(const line of lines){try{const value=JSON.parse(line);if(value.owner?.processId===Number(process.argv[2]))process.stdout.write(JSON.stringify(value)+"\\n")}catch{}}',
      input.headlessRestartReadyLogPath ?? input.headlessLaunchPath + '.restart.ndjson', String(result.spawnedOwnerPid)])
    const records = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (records.length) {
      const owner = records.at(-1).owner
      assert.equal(owner.runtimeId, input.expectedRuntimeId)
      assert.equal(owner.processId, result.spawnedOwnerPid)
      return owner
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('The same private Runtime did not confirm its new owner generation')
}

export function target(input) {
  return { hostId: 'farm-runtime', hostname: input.endpoint.host, user: input.endpoint.user,
    port: input.endpoint.port, identityFile: input.endpoint.identityFile,
    remoteCommand: input.endpoint.command, remoteSocketPath: input.endpoint.socketPath }
}

export function desktopInput(input) {
  const hostId = 'farm-runtime', workspaceId = 'farm-private-workspace'
  return { schema: 'agentmux.remote-runtime-native-input.v1', remoteEndpoint: { transport: 'ssh' },
    config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local Runtime' },
      { id: hostId, kind: 'ssh', label: 'Farm Runtime', hostname: input.endpoint.host,
        ...(input.endpoint.user ? { user: input.endpoint.user } : {}),
        ...(input.endpoint.port ? { port: input.endpoint.port } : {}),
        ...(input.endpoint.identityFile ? { identityFile: input.endpoint.identityFile } : {}),
        remoteCommand: input.endpoint.command, remoteSocketPath: input.endpoint.socketPath, runtimeId: input.expectedRuntimeId }],
      executors: { codex: { label: 'Remote Codex', providerId: 'codex', command: input.providerCommand, args: [], env: {}, injectAgentMuxGuide: false } },
      workspaces: [{ id: workspaceId, name: 'Farm private workspace', hostId, path: input.remoteWorkspace, kind: 'folder' }],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    identity: { runtimeId: input.expectedRuntimeId, hostId, workspaceId, tabId: 'farm-agent-tab', regionId: 'farm-agent-region',
      sessionId: input.agentSessionId, run: { runId: input.runId }, pid: input.pid, nativeHandle: input.nativeHandle },
    inputProbe: { kind: 'accepted-input-output', text: 'z' } }
}

export async function installSdkConsumer(input, evidence) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-farm-sdk-'))
  try {
    const archives = ['demand', 'core'].map(kind => input.localArchives[kind])
    for (const archive of archives) assert.equal(sha256(await fs.readFile(archive.path)), archive.sha256)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    const install = await execute('npm', ['install', '--prefix', root, '--omit=dev', '--no-audit', '--no-fund', ...archives.map(item => item.path)],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    await fs.writeFile(path.join(evidence, 'sdk-install.log'), install.stdout + install.stderr)
    const packageDirectory = path.join(root, 'node_modules/@agentmux/core')
    const entry = path.join(packageDirectory, 'dist/index.js')
    for (const [file, expected] of Object.entries(input.packageIdentity.compiledCoreHashes)) {
      // postinstall changes permissions, while the packed file bytes retain the package identity.
      assert.equal(sha256(await fs.readFile(path.join(packageDirectory, file))), expected, file)
    }
    return { root, entry, packageDirectory }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}

export async function writeReceipt(evidence, receipt) {
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}

export async function importInstalledCore(consumer) {
  return await import(pathToFileURL(consumer.entry).href)
}
