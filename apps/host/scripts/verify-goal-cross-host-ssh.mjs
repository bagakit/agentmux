import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, chmod, readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { inspectPortableHost } from './portable-host.mjs'
import { materializePackageClosure, inspectPackagePublication, DEVELOPMENT_FILE } from '../../../scripts/package-dependencies.mjs'
import { addLinuxAvatar } from './goal-cross-host-artifact.mjs'

const repository = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
const configuration = JSON.parse(await readFile(process.argv[2], 'utf8'))
for (const name of ['destination', 'nodePath', 'nativePath']) assert.ok(typeof configuration[name] === 'string' && !/[\0\r\n]/u.test(configuration[name]))
assert.ok(!configuration.destination.startsWith('-') && configuration.nodePath.startsWith('/') && configuration.nativePath.startsWith('/'))
const evidence = resolve(repository, '.local/state/goal-cross-host-verification')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const sshArguments = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=8', ...(configuration.port ? ['-p', String(configuration.port)] : []), ...(configuration.identityFile ? ['-i', configuration.identityFile] : [])]
const scpArguments = [...sshArguments.filter((value, index, values) => value !== '-p' && values[index - 1] !== '-p'), ...(configuration.port ? ['-P', String(configuration.port)] : [])]
const ssh = async command => (await execute('ssh', [...sshArguments, configuration.destination, command], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 })).stdout
const executeInput = (command, args, input = {}) => new Promise((yes, no) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('The private runtime command exceeded its deadline')) }, 60_000)
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.once('error', error => { clearTimeout(timer); no(error) })
  child.once('close', code => { clearTimeout(timer); code === 0 ? yes({ stdout, stderr }) : no(Error(stderr || stdout)) })
  child.stdin.end(JSON.stringify(input))
})
const inventory = await inspectPortableHost(resolve(repository, 'apps/host'))
const baseReceipt = configuration.artifactCache ? JSON.parse(await readFile(join(configuration.artifactCache, 'receipt.json'), 'utf8')) : null
if (baseReceipt?.sourceDirectories) {
  // Archive object ids stay exact when the shared owner adds previously missing
  // peer edges. Installed physical roots, rather than names, identify packages.
  const stable = new Map(Object.entries(baseReceipt.sourceDirectories).map(([id, path]) => [path, Number(id)]))
  let next = baseReceipt.packages.length
  const ids = new Map(inventory.packages.map(entry => [entry.id, stable.get(entry.sourceDirectory) ?? next++]))
  inventory.root = ids.get(inventory.root)
  inventory.packages = inventory.packages.map(entry => ({ ...entry, id: ids.get(entry.id), dependencies: entry.dependencies.map(dependency => ({ ...dependency, packageId: dependency.packageId === null ? null : ids.get(dependency.packageId) })) })).sort((a, b) => a.id - b.id)
  assert.ok(inventory.packages.every((entry, id) => entry.id === id), 'Retain every original package while adding exact peer edges')
}
// Keep Unix socket names below the macOS limit, independently of a long TMPDIR.
const directory = await mkdtemp('/tmp/amx-goal-cross-host-'), token = randomUUID()
const remoteRoot = (await ssh("python3 -c " + quote("import tempfile;print(tempfile.mkdtemp(prefix='amx-goal-cross-host-'))"))).trim()
assert.match(remoteRoot, /^\/tmp\/amx-goal-cross-host-[A-Za-z0-9_-]+$/u)
const remoteArtifact = configuration.remoteArtifactRoot ?? remoteRoot + '/artifact'
assert.match(remoteArtifact, /^\/tmp\/amx-goal-cross-host-[A-Za-z0-9_-]+\/artifact$/u)
const facts = [], cleanup = [], paths = { local: directory, remote: remoteRoot }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let localConfig, remoteConfig, startedLocal = false, startedRemote = false, success = false, archiveSHA256
const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
const sourceInputs = Object.fromEntries(await Promise.all(['apps/host/scripts/verify-goal-cross-host-ssh.mjs', 'apps/host/test/fixtures/goal-cross-host-runtime.mjs', 'apps/host/scripts/portable-host.mjs', 'scripts/package-dependencies.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs', 'pnpm-lock.yaml'].map(async path => [path, hash(await readFile(resolve(repository, path)))])))
const compiledEntries = ['packages/core/dist/index.js', 'packages/core/dist/client.js', 'packages/core/dist/public-rpc-service.js', 'packages/core/dist/agentmux.js',
  'apps/host/dist/index.js', 'packages/demand/dist/src/demand-store.js', 'packages/demand/dist/src/delegations.js', 'packages/demand/dist/src/goal-plan.js']
const compiledHashes = Object.fromEntries(await Promise.all(compiledEntries.map(async path => [path, hash(await readFile(resolve(repository, path)))])))
const publication = await inspectPackagePublication(inventory)
for (const entry of publication.packages) entry.files = entry.files.filter(file => !DEVELOPMENT_FILE.test(file.path))
const workspaceArtifactHashes = {}
for (const entry of publication.packages) {
  if (inventory.packages[entry.id].sourceDirectory.split('/').includes('node_modules')) continue
  const digest = createHash('sha256')
  for (let index = 0; index < entry.files.length; index += 16) {
    const files = entry.files.slice(index, index + 16)
    const contents = await Promise.all(files.map(file => readFile(file.source)))
    for (const [offset, file] of files.entries()) digest.update(file.path + '\0' + hash(contents[offset]) + '\n')
  }
  workspaceArtifactHashes[inventory.packages[entry.id].name] = digest.digest('hex')
}
const cacheKey = hash(JSON.stringify({ workspaceArtifactHashes, closure: inventory.packages.map(({ sourceDirectory: _, ...entry }) => entry), lock: sourceInputs['pnpm-lock.yaml'] }))
const cache = configuration.artifactCache ? resolve(configuration.artifactCache) : resolve(evidence, 'ssh-artifacts', cacheKey)
assert.ok(cache.startsWith(resolve(evidence, 'ssh-artifacts') + '/') && /^[a-f0-9]{64}$/u.test(cache.split('/').at(-1)))
const artifact = join(cache, 'artifact'), archive = join(cache, 'artifact.tar.gz')
let overlaySHA256, overlayPackages = []
const stage = phase => process.stdout.write(JSON.stringify({ phase }) + '\n')
await writeFile(resolve(evidence, 'ssh-private-roots.json'), JSON.stringify({ token, paths, sourceInputs, compiledHashes, artifactCache: cache }, null, 2), { mode: 0o600 })
try {
  const cached = await readFile(join(cache, 'receipt.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error })
  if (cached) {
    archiveSHA256 = hash(await readFile(archive)); assert.equal(archiveSHA256, cached.archiveSHA256)
    for (const entry of cached.packages) {
      const current = inventory.packages[entry.id]
      assert.equal(current?.name, entry.name); assert.equal(current?.version, entry.version)
      assert.equal(current?.manifestSha256, entry.manifestSha256, 'An original package manifest change requires an explicit new candidate')
    }
    facts.push({ case: 'exact-base-artifact-cache', ...cached })
    overlayPackages = publication.packages.filter(entry => entry.id >= cached.packages.length || workspaceArtifactHashes[inventory.packages[entry.id].name] &&
      workspaceArtifactHashes[inventory.packages[entry.id].name] !== cached.workspaceArtifactHashes[inventory.packages[entry.id].name])
    if (overlayPackages.length) {
      stage('overlay-current-published-workspace-packages')
      const overlay = join(directory, 'overlay')
      for (const entry of overlayPackages) {
        const target = join(artifact, entry.path)
        await mkdir(target, { recursive: true })
        for (const name of await readdir(target)) if (name !== 'node_modules') await rm(join(target, name), { recursive: true, force: true })
        for (const file of entry.files) {
          const relative = join(entry.path, file.path), snapshot = join(overlay, relative), original = join(artifact, relative)
          await mkdir(dirname(snapshot), { recursive: true }); await mkdir(dirname(original), { recursive: true })
          await copyFile(file.source, snapshot); await chmod(snapshot, file.mode)
          await copyFile(snapshot, original); await chmod(original, file.mode)
        }
      }
      await execute('tar', ['-C', overlay, '--no-xattrs', '--no-acls', ...(process.platform === 'darwin' ? ['--no-fflags', '--options=gzip:compression-level=1'] : []), '-czf', join(directory, 'overlay.tar.gz'), '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
      overlaySHA256 = hash(await readFile(join(directory, 'overlay.tar.gz')))
      facts.push({ case: 'exact-workspace-overlay', packages: overlayPackages.map(entry => inventory.packages[entry.id].name), overlaySHA256, workspaceArtifactHashes })
    }
  }
  else {
    stage('materialize-runtime-candidate'); await mkdir(cache, { recursive: true })
    // A missing complete receipt can only precede any private Host launch.
    await rm(artifact, { recursive: true, force: true })
    const packages = await materializePackageClosure(inventory, artifact, publication)
    const linuxNativeDependency = await addLinuxAvatar(artifact, resolve(evidence, 'native-cache'), repository)
    stage('archive-runtime-candidate')
    await execute('tar', ['-C', artifact, '--no-xattrs', '--no-acls', ...(process.platform === 'darwin' ? ['--no-fflags', '--options=gzip:compression-level=1'] : []), '-czf', archive, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    archiveSHA256 = hash(await readFile(archive))
    const cached = { archiveSHA256, compiledHashes, workspaceArtifactHashes, packages, linuxNativeDependency, sourceDirectories: Object.fromEntries(inventory.packages.map(entry => [entry.id, entry.sourceDirectory])) }
    await writeFile(join(cache, 'receipt.json'), JSON.stringify(cached, null, 2), { mode: 0o600 }); facts.push({ case: 'fresh-runtime-candidate', ...cached })
  }
  stage(configuration.remoteArtifactRoot ? 'reuse-exact-remote-candidate' : 'transfer-exact-candidate')
  const remoteArchive = configuration.remoteArtifactRoot ? dirname(remoteArtifact) + '/artifact.tar.gz' : remoteRoot + '/artifact.tar.gz'
  if (!configuration.remoteArtifactRoot) await execute('scp', [...scpArguments, archive, configuration.destination + ':' + remoteArchive], { timeout: 600_000 })
  else {
    const confirmed = JSON.parse(await ssh('cat ' + quote(dirname(remoteArtifact) + '/cleanup.json')))
    assert.equal(confirmed.tokenMatched, true); assert.ok(confirmed.host.absent || confirmed.host.stopped); assert.ok(confirmed.native.absent || confirmed.native.stopped)
  }
  const observedSHA256 = (await ssh('python3 -c ' + quote("import hashlib;from pathlib import Path;print(hashlib.sha256(Path(" + JSON.stringify(remoteArchive) + ").read_bytes()).hexdigest())"))).trim()
  assert.equal(observedSHA256, archiveSHA256, 'The remote Host must consume the exact transferred candidate')
  if (!configuration.remoteArtifactRoot) await ssh('mkdir ' + quote(remoteArtifact) + ' && tar -xzf ' + quote(remoteArchive) + ' -C ' + quote(remoteArtifact))
  if (overlayPackages.length) {
    stage('transfer-exact-workspace-overlay')
    await execute('scp', [...scpArguments, join(directory, 'overlay.tar.gz'), configuration.destination + ':' + remoteRoot + '/overlay.tar.gz'], { timeout: 600_000 })
    const actual = (await ssh('python3 -c ' + quote('import hashlib;from pathlib import Path;print(hashlib.sha256(Path(' + JSON.stringify(remoteRoot + '/overlay.tar.gz') + ').read_bytes()).hexdigest())'))).trim()
    assert.equal(actual, overlaySHA256)
    const remove = 'import shutil;from pathlib import Path;root=Path(' + JSON.stringify(remoteArtifact) + ');paths=' + JSON.stringify(overlayPackages.map(entry => entry.path)) + '\nfor relative in paths:\n p=root/relative\n p.mkdir(parents=True,exist_ok=True)\n for f in p.iterdir():\n  if f.name!="node_modules":\n   if f.is_dir() and not f.is_symlink():shutil.rmtree(f)\n   else:f.unlink()'
    await ssh('python3 -c ' + quote(remove) + ' && tar -xzf ' + quote(remoteRoot + '/overlay.tar.gz') + ' -C ' + quote(remoteArtifact))
  }
  const links = new Map()
  for (const entry of inventory.packages) for (const dependency of entry.dependencies) if (dependency.packageId !== null) links.set(entry.id + ':' + dependency.name, { from: entry.id, name: dependency.name, target: dependency.packageId })
  const linkList = [...links.values()]
  const linkProgram = 'import json,os;from pathlib import Path;root=Path(' + JSON.stringify(remoteArtifact + '/node_modules/.packages') + ');links=json.loads(' + JSON.stringify(JSON.stringify(linkList)) + ')\nfor e in links:\n p=root/str(e["from"])/"node_modules"/e["name"]\n p.parent.mkdir(parents=True,exist_ok=True)\n target=os.path.relpath(root/str(e["target"]),p.parent)\n if p.is_symlink():p.unlink()\n if not p.exists():p.symlink_to(target)'
  await ssh('python3 -c ' + quote(linkProgram))
  await executeInput('python3', ['-c', linkProgram.replace(JSON.stringify(remoteArtifact + '/node_modules/.packages'), JSON.stringify(join(artifact, 'node_modules/.packages')))])
  facts.push({ case: 'original-published-runtime-links', packages: inventory.packages.length, links: linkList, compiledWorkspacePackages: Object.keys(workspaceArtifactHashes) })
  const installedEntries = Object.fromEntries(compiledEntries.map(path => {
    const selected = path.startsWith('apps/host/') ? ['@agentmux/host', path.slice('apps/host/'.length)] : path.startsWith('packages/core/') ? ['@agentmux/core', path.slice('packages/core/'.length)] : ['@agentmux/demand', path.slice('packages/demand/'.length)]
    const entry = inventory.packages.find(item => item.name === selected[0])
    return [path, 'node_modules/.packages/' + entry.id + '/' + selected[1]]
  }))
  for (const [source, target] of Object.entries(installedEntries)) assert.equal(hash(await readFile(join(artifact, target))), compiledHashes[source], 'The local candidate entry must match its original build')
  const verify = 'import json,hashlib;from pathlib import Path;root=Path(' + JSON.stringify(remoteArtifact) + ');entries=json.loads(' + JSON.stringify(JSON.stringify(installedEntries)) + ');print(json.dumps({key:hashlib.sha256((root/value).read_bytes()).hexdigest() for key,value in entries.items()}))'
  assert.deepEqual(JSON.parse(await ssh('python3 -c ' + quote(verify))), compiledHashes, 'Both Hosts must consume the exact current compiled owners')
  for (const [source, name] of [['packages/core/test/fixtures/fake-codex-cli.mjs', 'fake-codex-cli.mjs'], ['apps/host/test/fixtures/goal-cross-host-runtime.mjs', 'goal-cross-host-runtime.mjs']]) {
    await copyFile(resolve(repository, source), join(directory, name))
    await execute('scp', [...scpArguments, join(directory, name), configuration.destination + ':' + remoteRoot + '/' + name], { timeout: 60_000 })
    const actual = (await ssh('python3 -c ' + quote('import hashlib;from pathlib import Path;print(hashlib.sha256(Path(' + JSON.stringify(remoteRoot + '/' + name) + ').read_bytes()).hexdigest())'))).trim()
    assert.equal(actual, sourceInputs[source], 'Both original private fixture copies must be exact')
  }
  const worker = join(directory, 'goal-cross-host-runtime.mjs'), remoteWorker = remoteRoot + '/goal-cross-host-runtime.mjs'
  const invoke = async (side, action, input = {}) => {
    if (side === 'a') {
      const run = await executeInput(process.execPath, [worker, action, localConfig], input)
      return JSON.parse(run.stdout)
    }
    const body = Buffer.from(JSON.stringify(input)).toString('base64')
    const command = 'printf %s ' + quote(body) + ' | base64 -d | ' + quote(configuration.nodePath) + ' ' + quote(remoteWorker) + ' ' + quote(action) + ' ' + quote(remoteConfig)
    return JSON.parse(await ssh(command))
  }
  const cli = async (side, role, args, body) => {
    const result = await invoke(side, 'cli', { role, args, ...(body === undefined ? {} : { body }) })
    facts.push({ side, role, args, body, result })
    return result
  }
  const call = async (side, role, args, body) => {
    const result = await cli(side, role, args, body)
    assert.equal(result.code, 0, result.stderr || result.stdout)
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.ok, true); return receipt.result
  }
  remoteConfig = remoteRoot + '/runtime-config.json'
  const bConfig = { root: remoteRoot, artifact: remoteArtifact, providerPath: remoteRoot + '/fake-codex-cli.mjs', token, nodePath: configuration.nodePath,
    nativePath: remoteArtifact + '/node_modules/@agentmux/host/node_modules/@agentmux/core/vendor/ctxmux/linux-x64/bin/ctxmuxd', label: 'Private remote worker', roles: ['worker'] }
  await ssh('printf %s ' + quote(Buffer.from(JSON.stringify(bConfig)).toString('base64')) + ' | base64 -d > ' + quote(remoteConfig) + ' && chmod 600 ' + quote(remoteConfig))
  startedRemote = true
  stage('start-private-remote-native-host')
  const b = await invoke('b', 'start'); facts.push({ case: 'remote-actual-host-and-native', value: b })
  assert.equal(b.owner.ctxmux !== null, true)
  assert.equal(b.nativeSHA256, hash(await readFile(resolve(repository, 'packages/core/vendor/ctxmux/linux-x64/bin/ctxmuxd'))))
  const at = configuration.destination.lastIndexOf('@'), hostname = at < 0 ? configuration.destination : configuration.destination.slice(at + 1), user = at < 0 ? undefined : configuration.destination.slice(0, at)
  localConfig = join(directory, 'runtime-config.json')
  const aRoot = join(directory, 'owner-a')
  await mkdir(aRoot, { mode: 0o700 })
  await writeFile(localConfig, JSON.stringify({ root: aRoot, artifact, providerPath: join(directory, 'fake-codex-cli.mjs'), token, nodePath: process.execPath, label: 'Private original Goal owner', roles: ['supervisor', 'reviewer'],
    peer: { id: 'worker-b', kind: 'ssh', label: 'Private remote worker', hostname, ...(user ? { user } : {}), ...(configuration.port ? { port: configuration.port } : {}), ...(configuration.identityFile ? { identityFile: configuration.identityFile } : {}),
      runtimeId: b.owner.runtimeId, remoteCommand: remoteRoot + '/bin/amux', remoteSocketPath: b.socketPath } }), { mode: 0o600 })
  startedLocal = true
  stage('start-private-local-native-host')
  const a = await invoke('a', 'start'); facts.push({ case: 'local-actual-host-and-native', value: a })
  assert.notEqual(a.owner.runtimeId, b.owner.runtimeId)
  const authorityA = await call('a', null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  const authorityB = await call('b', null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  const awaitOriginalRoute = async () => {
    const end = Date.now() + 25_000
    do {
      const read = await cli('a', null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'worker-b'])
      if (read.code === 0) { assert.equal(JSON.parse(read.stdout).result.authority.runtimeId, b.owner.runtimeId); return }
      // Only the read-only original connection is observed. No uncertain write,
      // task or approval is replayed while the Host consumer reconnects.
      await new Promise(yes => setTimeout(yes, 100))
    } while (Date.now() < end)
    throw Error('The original private SSH route remains unconfirmed; retain the original IDs')
  }
  await awaitOriginalRoute()
  stage('public-cli-signed-goal-workflow')
  const pin = async (side, source, target) => await call(side, null, ['settings', 'hosts', 'trust-message-source', '--host', 'local', '--input', '-'], {
    sourceRuntimeId: source.authority.runtimeId, publicKey: source.authority.publicKey, targetRuntimeId: target.authority.runtimeId, targetKeyFingerprint: target.authority.fingerprint })
  await pin('b', authorityA, authorityB); await pin('a', authorityB, authorityA)
  const supervisor = a.roles.supervisor.agentSessionId, reviewer = a.roles.reviewer.agentSessionId, workerId = b.roles.worker.agentSessionId
  const goalId = (await call('a', null, ['goal', 'create', '--title', 'Deliver the original SSH result', '--description', 'Original human intent remains intact.', '--status', 'in_progress', '--session', supervisor,
    '--assignees', JSON.stringify([supervisor, reviewer, workerId]), '--supervisor', supervisor, '--risk', 'low', '--confirm', 'user', '--operation-id', 'private-ssh-create'])).goal.id
  const aligned = await call('a', null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({ summary: 'Check the original signed remote report.', criteria: [{ id: 'signed-report', text: 'The received report retains its original signature and Goal criteria.' }], openQuestions: [] })])
  const alignmentRevision = aligned.goal.alignment.revision
  const nodes = ['first', 'dependent'].map(id => ({ id, title: 'Deliver ' + id, outcome: 'Verify the original ' + id, dependsOn: id === 'dependent' ? ['first'] : [], criterionIds: ['signed-report'],
    check: 'node --test checks/original.test.mjs', executor: { hostId: 'worker-b', agentSessionId: workerId } }))
  await call('a', 'supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: { operationId: 'private-ssh-plan', expectedRevision: 0, alignmentRevision, nodes } })
  const intent = node => ({ operationId: 'private-ssh-delegate-' + node, sourceMessageId: 'private-ssh-source-' + node, hostId: 'local', workerHostId: 'worker-b', ownerAgentSessionId: supervisor,
    workerAgentSessionId: workerId, ownerRunId: a.roles.supervisor.run.runId, workerRunId: b.roles.worker.run.runId, threadId: 'private-ssh-thread-' + node,
    text: 'Deliver the original ' + node + ' result through this signed thread.', alignmentRevision, criterionIds: ['signed-report'], planNodeId: node })
  const blocked = await cli('a', 'supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  assert.equal(blocked.code, 1); assert.match(blocked.stderr, /only a ready node/u)
  await call('a', 'supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('first') })
  assert.deepEqual((await call('b', null, ['goal', 'ls', '--all'])).goals, [])
  stage('typed-question-answer-and-signed-peer-inbox')
  const sourceMessageId = 'private-ssh-source-first', questionMessageId = 'private-ssh-question', answerMessageId = 'private-ssh-answer'
  await call('b', 'worker', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId },
    operationId: 'private-ssh-question-operation', messageId: questionMessageId, text: 'Which exact original criterion should I check?' })
  const question = await call('b', 'worker', ['message', 'dispatch', 'report', '--source-message', sourceMessageId, '--reply-message', questionMessageId, '--kind', 'question'])
  assert.equal(question.kind, 'dispatch-event-submission')
  const pendingQuestion = await call('a', 'supervisor', ['message', 'dispatch', 'sync', '--source-message', sourceMessageId, '--host', 'worker-b'])
  assert.ok(pendingQuestion.dispatch.events.some(event => event.kind === 'question' && event.replyMessageId === questionMessageId))
  assert.equal(pendingQuestion.dispatch.originAwaits, true)
  assert.equal(pendingQuestion.remoteSource.runtimeId, b.owner.runtimeId)
  const preparedAnswer = await call('a', 'supervisor', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: questionMessageId },
    operationId: 'private-ssh-answer-operation', messageId: answerMessageId, text: 'Check the exact original signed report and keep its evidence.' })
  assert.equal(preparedAnswer.transport.state, 'outbox')
  const beforePush = (await call('a', 'supervisor', ['message', 'read', '--host', 'local', '--message-id', answerMessageId])).message
  assert.equal(beforePush.peerInbox, undefined, 'A prepared answer must not claim a receiving-Core inbox receipt')
  await call('a', 'supervisor', ['message', 'dispatch', 'sync', '--source-message', sourceMessageId, '--host', 'worker-b'])
  const answerAtB = (await call('b', 'worker', ['message', 'read', '--host', 'local', '--message-id', answerMessageId])).message
  assert.equal(answerAtB.envelope.replyTo, questionMessageId); assert.equal(answerAtB.envelope.threadId, 'private-ssh-thread-first')
  assert.equal(answerAtB.envelope.senderRuntimeId, a.owner.runtimeId); assert.equal(answerAtB.envelope.recipientRuntimeId, b.owner.runtimeId)
  const confirmedAnswer = (await call('a', 'supervisor', ['message', 'read', '--host', 'local', '--message-id', answerMessageId])).message
  assert.equal(confirmedAnswer.peerInbox.runtimeId, b.owner.runtimeId); assert.equal(confirmedAnswer.peerInbox.messageId, answerMessageId)
  assert.equal(confirmedAnswer.peerInbox.sequence, answerAtB.sequence)
  facts.push({ case: 'actual-ssh-typed-question-answer-and-peer-receipt', question, pendingQuestion, beforePush, answerAtB, confirmedAnswer })
  const report = { operationId: 'private-ssh-report', replyMessageId: 'private-ssh-reply', authorAgentSessionId: workerId,
    grounding: { alignmentRevision, summary: 'Original remote worker report.', checks: [{ criterionId: 'signed-report', outcome: 'met', evidence: ['checks/remote.log:1'], note: '' }] } }
  const submission = await call('b', 'worker', ['goal', 'report', '--input', '-'], { goalId, operationId: 'private-ssh-delegate-first', sourceMessageId: 'private-ssh-source-first', report })
  assert.equal(submission.kind, 'report-submission'); assert.equal(submission.submission.transport.state, 'outbox')
  assert.equal(submission.submission.transport.targetRuntimeId, a.owner.runtimeId)
  const originalReply = (await call('b', 'worker', ['message', 'read', '--host', 'local', '--message-id', report.replyMessageId])).message
  const restarted = await invoke('b', 'restart-host'); assert.equal(restarted.owner.runtimeId, b.owner.runtimeId); assert.notEqual(restarted.owner.ownerInstanceId, b.owner.ownerInstanceId)
  await awaitOriginalRoute()
  await call('a', 'supervisor', ['goal', 'collect', '--input', '-'], { goalId, operationId: 'private-ssh-delegate-first', collection: { operationId: 'private-ssh-collect', replyMessageId: report.replyMessageId } })
  const received = (await call('a', 'supervisor', ['message', 'read', '--host', 'local', '--message-id', report.replyMessageId])).message
  assert.deepEqual(received.provenance, originalReply.provenance)
  const beforeReview = await cli('a', 'supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  assert.equal(beforeReview.code, 1); assert.match(beforeReview.stderr, /only a ready node/u)
  const check = await invoke('a', 'check', { worker: originalReply, received, sourceMessageId: 'private-ssh-source-first' }); assert.match(check.result, /pass 1/u)
  await call('a', 'reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId, review: { operationId: 'private-ssh-review', nodeId: 'first', delegationOperationId: 'private-ssh-delegate-first', verdict: 'pass', check, note: '' } })
  const unlocked = await call('a', 'supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  assert.equal(unlocked.delegations.length, 2)
  assert.deepEqual((await call('b', null, ['goal', 'ls', '--all'])).goals, [])
  const final = await call('a', null, ['goal', 'inspect', '--goal', goalId]); assert.equal(final.goal.status, 'in_progress'); assert.equal(final.goal.grounding.acceptedAt, null)
  facts.push({ case: 'actual-ssh-signed-goal-closed-loop', a: a.owner, b: b.owner, restarted: restarted.owner, originalReply, received, final, check, unlocked })
  success = true
} finally {
  stage('cleanup-original-private-identities')
  const worker = join(directory, 'goal-cross-host-runtime.mjs')
  if (startedLocal) try {
    const result = await executeInput(process.execPath, [worker, 'cleanup', localConfig]); cleanup.push({ side: 'a', ...JSON.parse(result.stdout) })
  } catch (error) { cleanup.push({ side: 'a', error: error.message }) }
  if (startedRemote) try {
    const result = await ssh('printf %s ' + quote('{}') + ' | ' + quote(configuration.nodePath) + ' ' + quote(remoteRoot + '/goal-cross-host-runtime.mjs') + ' cleanup ' + quote(remoteConfig)); cleanup.push({ side: 'b', ...JSON.parse(result) })
  } catch (error) { cleanup.push({ side: 'b', error: error.message }) }
  const complete = cleanup.every(value => !value.error)
  const receipt = { schema: 'agentmux.goal-cross-host-real-ssh-proof.v1', success, scope: 'Actual packaged public CLI, two real Core/Host processes, official Native and deterministic private Provider processes. All A to B messages and signed pull cross real SSH; no reverse B route or foreign Goal Store. No live account or live trust mutation.', candidate: { commit, archiveSHA256, overlaySHA256, compiledHashes, workspaceArtifactHashes }, sourceInputs, paths, facts, cleanup }
  await writeFile(resolve(evidence, 'ssh-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  if (complete && success) {
    await ssh('rm -rf -- ' + quote(remoteRoot)); await rm(directory, { recursive: true, force: true })
  }
  assert.ok(complete, 'Private process cleanup is unconfirmed; original task-owned roots and receipt are retained')
}
assert.ok(success)
process.stdout.write(JSON.stringify({ schema: 'agentmux.goal-cross-host-real-ssh-proof.v1', success, cases: facts.length, cleanup: cleanup.length }) + '\n')
