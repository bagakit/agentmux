import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { connectAgentMuxRpc } from '../../../../../packages/core/dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../../../packages/core/dist/hosted-client.js'

const execute = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/u.test(value)
export function toolSceneOptions(args) {
  const seen = new Set(); let remoteReceipt, direction = 'remote-agent'
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    assert(['--tool-workspace', '--remote-target', '--direction'].includes(flag) && !seen.has(flag), 'Unknown or repeated scene flag')
    seen.add(flag)
    if (flag !== '--tool-workspace') {
      const value = args[++index]; assert(value && !value.startsWith('--'), flag + ' requires a value')
      if (flag === '--remote-target') remoteReceipt = path.resolve(value)
      else { assert(['remote-agent', 'local-agent', 'both'].includes(value), 'Unknown execution direction'); direction = value }
    }
  }
  assert(!remoteReceipt || seen.has('--tool-workspace'), 'A remote target requires the real tool-workspace scene')
  assert(!seen.has('--direction') || remoteReceipt, 'An explicit direction requires the original authorized remote target')
  return { toolMode: seen.has('--tool-workspace'), remoteReceipt, direction }
}

export function remoteTarget(authorization) {
  assert.equal(authorization.schema, 'agentmux.cross-host-target-authorization.v1')
  assert.equal(authorization.source?.role, 'user')
  assert(['kind', 'answer', 'scope'].every(key => typeof authorization.source[key] === 'string' && authorization.source[key].length > 0))
  const candidate = authorization.executionCandidate, remote = candidate?.remote
  assert.equal(candidate?.schema, 'agentmux.cross-host-installed-candidate.v1')
  assert(/^[a-f0-9]{40}$/u.test(candidate.sourceCommit) && /^[a-zA-Z0-9_-]{8,100}$/u.test(candidate.scopeId))
  assert(remote && ['installedRoot', 'packageRoot', 'nodePath', 'codexDirectory', 'profileRoot', 'command'].every(key => absolute(remote[key])))
  assert(!['/', '/tmp', '/home'].includes(remote.installedRoot) && !['/', '/tmp', '/home'].includes(remote.profileRoot))
  assert(['packageRoot', 'codexDirectory', 'command'].every(key => remote[key].startsWith(remote.installedRoot + '/')))
  const endpoint = remote.endpoint
  assert(endpoint?.transport === 'ssh' && typeof endpoint.host === 'string' && !endpoint.host.startsWith('-') && !/[\s\0]/u.test(endpoint.host))
  assert(endpoint.user === undefined || /^[a-zA-Z0-9_.-]+$/u.test(endpoint.user))
  assert(endpoint.port === undefined || Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port < 65536)
  assert(endpoint.identityFile === undefined || absolute(endpoint.identityFile))
  const target = endpoint.user ? endpoint.user + '@' + endpoint.host : endpoint.host
  assert.equal(target, authorization.remote?.sshTarget)
  assert.equal(remote.nodePath, authorization.remote?.verifiedNodePath)
  assert(absolute(candidate.candidateReceipt))
  return { candidate, remote, endpoint, target }
}

/** Reuse the committed private owner supervisor, never an existing service or an install action. */
export async function startRemoteToolCore(root, repository, evidence, owners, cleanup, receiptPath) {
  const source = await fs.readFile(receiptPath), authorization = JSON.parse(source), { candidate, remote, endpoint, target } = remoteTarget(authorization)
  const built = JSON.parse(await fs.readFile(candidate.candidateReceipt, 'utf8'))
  assert.equal(built.sourceCommit, candidate.sourceCommit)
  const expected = Object.fromEntries(Object.entries(built.compiledHashes ?? {}).filter(([file]) => file.startsWith('packages/core/dist/') && file.endsWith('.js'))
    .map(([file, hash]) => [file.slice('packages/core/'.length), hash]))
  assert(Object.keys(expected).length > 0 && Object.values(expected).every(hash => /^[a-f0-9]{64}$/u.test(hash)), 'Installed Core JS build identity is required')
  // The final verifier also runs from a frozen git-archive snapshot with no .git.
  // The exact consumed fixture bytes are hashed in the lease and parent input manifest.
  const supervisor = await fs.readFile(path.join(repository, 'packages/core/scripts/fixtures/cross-host-execution-owner.mjs'), 'utf8')
  const scope = 'ui-' + randomUUID(), base = path.posix.join(remote.installedRoot, scope), profileBase = path.posix.join(remote.profileRoot, scope)
  const cfg = { base, profileBase, expectedSourceCommit: candidate.sourceCommit, packageRoot: remote.packageRoot,
    nodePath: remote.nodePath, codexPath: remote.codexDirectory, modelPort: 1 }
  const owner = { name: 'agent', base, remote: true, logs: [], sessions: [], runs: [] }; owners.push(owner)
  const sshArgs = ['-T', '-o', 'BatchMode=yes', ...(endpoint.port ? ['-p', String(endpoint.port)] : []), ...(endpoint.identityFile ? ['-i', endpoint.identityFile] : [])]
  const command = args => [...sshArgs, target, args.map(quote).join(' ')]
  const setup = `const f=require('node:fs'),p=require('node:path'),c=require('node:crypto'),a=require('node:assert/strict');const v=JSON.parse(f.readFileSync(0,'utf8'));const marker=JSON.parse(f.readFileSync(p.join(v.remote.installedRoot,'.agentmux-cross-host-test-root.json'),'utf8'));a.deepEqual(marker,v.marker);for(const [file,expected]of Object.entries(v.expected))a.equal(c.createHash('sha256').update(f.readFileSync(p.join(v.remote.packageRoot,file))).digest('hex'),expected,file);a.equal(process.version,v.nodeVersion);a.equal(process.platform,'linux');f.mkdirSync(v.cfg.base,{mode:448});f.writeFileSync(p.join(v.cfg.base,'owner.mjs'),v.supervisor,{mode:384});f.writeFileSync(p.join(v.cfg.base,'owner-input.json'),JSON.stringify(v.cfg),{mode:384});console.log(JSON.stringify({matchedCoreModules:Object.keys(v.expected).length,marker,platform:process.platform,arch:process.arch,node:process.version}));`
  const prepared = execute('ssh', command([remote.nodePath, '-e', setup]), { maxBuffer: 1024 * 1024 })
  cleanup.trackChild(owner, 'ssh-setup', prepared.child)
  prepared.child.stdin.end(JSON.stringify({ remote, expected, cfg, supervisor, nodeVersion: authorization.remote.verifiedNodeVersion,
    marker: { schema: 'agentmux.cross-host-test-installation.v1', scopeId: candidate.scopeId, sourceCommit: candidate.sourceCommit,
      hostId: authorization.remote.hostId, profileRoot: remote.profileRoot, nodePath: remote.nodePath } }))
  const installed = JSON.parse((await prepared).stdout)
  const child = spawn('ssh', command([remote.nodePath, path.posix.join(base, 'owner.mjs'), path.posix.join(base, 'owner-input.json')]), { stdio: ['pipe', 'pipe', 'pipe'] })
  cleanup.trackChild(owner, 'ssh-owner', child)
  child.stderr.on('data', bytes => owner.logs.push(bytes.toString()))
  child.stdin.on('error', error => owner.logs.push('Supervisor stdin: ' + String(error)))
  let readyResolve, readyReject, stopResolve
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const stopped = new Promise(resolve => { stopResolve = resolve })
  const closed = new Promise(resolve => child.once('close', (code, signal) => { readyReject(new Error('Private remote owner closed before readiness')); resolve({ code, signal }) }))
  child.on('error', readyReject)
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try { const value = JSON.parse(line); if (value.socketPath) readyResolve(value); else if (value.stopped === true) stopResolve(value); else owner.logs.push(line) }
    catch (error) { readyReject(error) }
  })
  const wait = async (promise, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' unconfirmed')), 60000) })]) } finally { clearTimeout(timer) } }
  owner.stopRemote = async () => {
    assert(child.exitCode === null && child.signalCode === null, 'The original remote supervisor exited without a confirmed stop receipt')
    child.stdin.end('stop\n')
    const reply = await wait(stopped, 'Original remote supervisor stop'), exit = await wait(closed, 'Original SSH supervisor close')
    assert.deepEqual(reply.errors, []); assert.equal(exit.code, 0); assert.equal(exit.signal, null)
    await fs.writeFile(path.join(evidence, 'remote-owner-cleanup.json'), JSON.stringify({ scope, base, profileBase, reply, exit, owner: owner.receipt }, null, 2), { mode: 0o600 })
  }
  owner.receipt = await wait(ready, 'Original remote owner readiness')
  assert.equal(owner.receipt.candidateCommit, candidate.sourceCommit)
  assert.equal(owner.receipt.base, base); assert.equal(owner.receipt.profileBase, profileBase)
  owner.endpoint = { ...endpoint, command: remote.command, socketPath: owner.receipt.socketPath }
  owner.rpc = await connectAgentMuxRpc({ endpoint: owner.endpoint })
  owner.client = await connectHostedAgentMux({ rpc: owner.rpc }); await owner.client.connectRuntime()
  assert.equal(owner.client.runtimeOwnerIdentity().runtimeId, owner.receipt.owner.runtimeId)
  owner.hostConfig = { id: 'agent', kind: 'ssh', label: 'SSH Host — private UI scope', hostname: endpoint.host,
    ...(endpoint.user ? { user: endpoint.user } : {}), ...(endpoint.port ? { port: endpoint.port } : {}), ...(endpoint.identityFile ? { identityFile: endpoint.identityFile } : {}),
    remoteCommand: remote.command, remoteSocketPath: owner.receipt.socketPath, runtimeId: owner.receipt.owner.runtimeId }
  owner.workspacePath = path.posix.join(base, 'workspace')
  const lease = { schema: 'agentmux.desktop-ssh-proof-lease.v1', scope, base, profileBase, endpoint: owner.endpoint,
    source: { receipt: path.resolve(receiptPath), sha256: digest(source), authorization: authorization.source },
    sourceCommit: candidate.sourceCommit, coreHashes: expected, candidateReceipt: { path: candidate.candidateReceipt, sha256: digest(await fs.readFile(candidate.candidateReceipt)) }, supervisorSha256: digest(supervisor), installed, owner: owner.receipt, connectedOwner: owner.client.runtimeOwnerIdentity(),
    localSupervisorPid: child.pid, ownsNewScopeOnly: true, installedPackageReadOnly: true }
  await fs.writeFile(path.join(root, 'remote-owner-lease.json'), JSON.stringify(lease), { mode: 0o600 })
  await fs.writeFile(path.join(evidence, 'remote-owner-lease.json'), JSON.stringify(lease, null, 2), { mode: 0o600 })
  process.stderr.write('Private SSH UI lease: ' + path.join(evidence, 'remote-owner-lease.json') + '\n')
  return owner
}
