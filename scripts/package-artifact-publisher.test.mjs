import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modulePath = process.env.AGENTMUX_ARTIFACT_PUBLISHER_SOURCE ?? fileURLToPath(new URL('./package-artifact-publisher.mjs', import.meta.url))
const { publishPackageArtifact, observeArtifactOccupancy, runArtifactCommand } = await import(pathToFileURL(modulePath).href)
const free = async () => ({ state: 'free' })
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
async function fixture(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-artifact-owner-')))
  await exec('git', ['init', '-q', root])
  try { await action(root) } finally { await rm(root, { recursive: true, force: true }) }
}
async function source(root, id = 'current') {
  const path = join(root, id + '.tar.gz'), bytes = Buffer.from(`Qualified fixture archive ${id}\n`.repeat(100))
  await writeFile(path, bytes)
  return { repositoryRoot: root, target: 'linux-x64', archive: path, sha256: hash(bytes) }
}
const publish = async (root, id, observeOccupancy = free) => publishPackageArtifact(await source(root, id), { observeOccupancy })
const payloads = async root => {
  const directory = join(root, '.local/package-delivery/artifacts/linux-x64'), found = []
  for (const name of await readdir(directory)) {
    const receipt = await readFile(join(directory, name, 'receipt.json'), 'utf8').then(JSON.parse, () => null)
    if (receipt && await exists(join(directory, name, receipt.archive))) found.push(join(directory, name, receipt.archive))
  }
  return found
}

test('complete receipt and exact copy precede retention; cleaned receipts never displace the latest two payloads', async () => fixture(async root => {
  const receipts = []
  for (let id = 0; id < 5; id++) {
    const result = await publish(root, 'release-' + id, async path => {
      assert(receipts.length >= 2)
      const complete = await payloads(root); assert(complete.length >= 3)
      assert(complete.some(value => value.endsWith('release-' + id + '.tar.gz')))
      return free(path)
    })
    assert.equal(result.publication.status, 'published'); receipts.push(result.publication)
    assert.equal(hash(await readFile(result.publication.path)), result.publication.sha256)
    const receipt = JSON.parse(await readFile(result.publication.receiptPath, 'utf8'))
    const info = await lstat(result.publication.path, { bigint: true })
    assert.equal(receipt.payload.ino, String(info.ino)); assert.equal(receipt.payload.ctimeNs, String(info.ctimeNs))
  }
  assert.deepEqual((await payloads(root)).map(path => path.split('/').at(-1)).sort(), ['release-3.tar.gz', 'release-4.tar.gz'])
  assert.equal(await exists(receipts[0].receiptPath), true)
}))

test('in-use and unknown archives survive; pending, malformed, replaced and linked objects are untouched', async () => fixture(async root => {
  const first = await publish(root, 'in-use'), second = await publish(root, 'unknown')
  const modified = await publish(root, 'modified', async () => ({ state: 'unknown' }))
  await rename(modified.publication.path, modified.publication.path + '.original')
  await writeFile(modified.publication.path, 'Replacement payload is not owned by the old receipt.')
  const linked = await publish(root, 'linked', async () => ({ state: 'unknown' }))
  await rm(linked.publication.path); await symlink(first.publication.path, linked.publication.path)
  const malformed = await publish(root, 'malformed', async () => ({ state: 'unknown' }))
  await writeFile(malformed.publication.receiptPath, '{invalid receipt')
  const directory = dirname(dirname(first.publication.path)), pending = join(directory, '.pending-foreign')
  await mkdir(pending); await writeFile(join(pending, 'unfinished'), 'Keep pending work')
  const last = await publish(root, 'newest', async path => ({ state: path === first.publication.path ? 'in-use' : 'unknown' }))
  assert.equal(last.cleanup.removed.length, 0)
  for (const result of [first, second, modified, linked, malformed]) assert(await exists(result.publication.path))
  assert((await lstat(linked.publication.path)).isSymbolicLink())
  assert.equal(await readFile(modified.publication.path, 'utf8'), 'Replacement payload is not owned by the old receipt.')
  assert.equal(await readFile(join(pending, 'unfinished'), 'utf8'), 'Keep pending work')
}))

test('a linked artifact root or source is rejected without touching its target', async () => fixture(async root => {
  const input = await source(root), outside = join(root, 'outside')
  await mkdir(outside); await symlink(outside, join(root, '.local'))
  const result = await publishPackageArtifact(input)
  assert.equal(result.publication.status, 'failed'); assert.deepEqual(await readdir(outside), [])
  await rm(join(root, '.local')); await symlink(input.archive, join(root, 'linked.tar.gz'))
  const linked = await publishPackageArtifact({ ...input, archive: join(root, 'linked.tar.gz') })
  assert.equal(linked.publication.status, 'failed'); assert(await exists(input.archive))
}))

test('a payload or root replaced during occupancy observation is retained', async () => fixture(async root => {
  const first = await publish(root, 'first'); await publish(root, 'second')
  const result = await publish(root, 'third', async path => {
    assert.equal(path, first.publication.path)
    await rename(path, path + '.original'); await writeFile(path, 'Later replacement')
    return { state: 'free' }
  })
  assert.equal(result.publication.status, 'published'); assert.equal(result.cleanup.removed.length, 0)
  assert.equal(await readFile(first.publication.path, 'utf8'), 'Later replacement')
}))

test('failed publication removes its own partial copy and keeps the original qualified archive', async () => fixture(async root => {
  const input = await source(root), writes = [], originalWrite = process.stdout.write
  let result
  try {
    process.stdout.write = value => { writes.push(String(value)); return true }
    result = await publishPackageArtifact({ ...input, sha256: '0'.repeat(64) })
  } finally { process.stdout.write = originalWrite }
  assert.deepEqual(writes, [], 'Shared publisher never writes to its caller’s global stdout')
  assert.equal(result.publication.status, 'failed'); assert(await exists(input.archive))
  assert.deepEqual(await readdir(join(root, '.local/package-delivery/artifacts/linux-x64')), [])
}))

test('cleanup denial leaves a published candidate usable and reports its own failure separately', async () => fixture(async root => {
  const first = await publish(root, 'first'); await publish(root, 'second')
  let result
  try { result = await publish(root, 'third', async path => { await chmod(dirname(path), 0o500); return { state: 'free' } }) }
  finally { await chmod(dirname(first.publication.path), 0o700) }
  assert.equal(result.publication.status, 'published'); assert.equal(result.cleanup.status, 'partial')
  assert(await exists(first.publication.path)); assert.equal(hash(await readFile(result.publication.path)), result.publication.sha256)
}))

test('concurrent publishers keep complete current archives and share the original Git repository root', async () => fixture(async root => {
  await writeFile(join(root, 'tracked'), 'Shared worktree fixture')
  await exec('git', ['-C', root, 'add', 'tracked'])
  await exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'])
  const checkout = join(root, 'checkout'); await exec('git', ['-C', root, 'worktree', 'add', '--detach', checkout])
  const inputs = await Promise.all([source(root, 'one'), source(root, 'two'), source(root, 'three')])
  const code = `const {publishPackageArtifact}=await import(${JSON.stringify(pathToFileURL(modulePath).href)});const result=await publishPackageArtifact(JSON.parse(process.argv[1]),{observeOccupancy:async()=>({state:'unknown'})});console.log('RESULT '+JSON.stringify(result))`
  const results = await Promise.all(inputs.map(async input => {
    const result = await exec(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ ...input, repositoryRoot: checkout })])
    return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7))
  }))
  assert.equal(results.length, 3)
  assert(results.every(result => result.publication.status === 'published'))
  assert(results.every(result => result.publication.path.startsWith(join(root, '.local/package-delivery/artifacts/') )))
  for (const result of results) assert.equal(hash(await readFile(result.publication.path)), result.publication.sha256)
  assert.equal(await exists(join(checkout, '.local/package-delivery/artifacts')), false)
}))

test('occupancy leaf distinguishes exact open files, normal no-match, attached images and uncertainty', async () => fixture(async root => {
  const input = await source(root), calls = []
  const run = async (command, args) => { calls.push([command, args]); return { code: 1, signal: null, stdout: '', stderr: '' } }
  assert.equal((await observeArtifactOccupancy(input.archive, { platform: 'linux', run })).state, 'free')
  assert.deepEqual(calls, [['lsof', ['-nP', '-F', 'p', '--', input.archive]]])
  for (const leaf of [{ code: 0, stdout: 'p123\n', stderr: '' }, { code: 1, stdout: '', stderr: 'warning' }, { code: 2, stdout: '', stderr: '' }, { code: null, error: 'ENOENT', stdout: '', stderr: '' }]) {
    assert.equal((await observeArtifactOccupancy(input.archive, { platform: 'linux', run: async () => leaf })).state, leaf.code === 0 ? 'in-use' : 'unknown')
  }
  const dmg = join(root, 'fixture.dmg'); await copyFile(input.archive, dmg)
  const mac = async images => observeArtifactOccupancy(dmg, { platform: 'darwin', run: async command => command === 'hdiutil'
    ? { code: 0, stdout: '<controlled plist>', stderr: '' }
    : command === 'plutil' ? { code: 0, stdout: JSON.stringify({ images }), stderr: '' } : { code: 1, stdout: '', stderr: '' } })
  assert.equal((await mac([{ 'image-path': dmg }])).state, 'in-use')
  assert.equal((await mac([])).state, 'free')
  assert.equal((await mac([{ 'image-path': join(root, 'unrelated-moved-image.dmg') }])).state, 'free')
  assert.equal((await mac([{}])).state, 'unknown')
  const tarCalls = []
  assert.equal((await observeArtifactOccupancy(input.archive, { platform: 'darwin', run: async command => {
    tarCalls.push(command); if (command !== 'lsof') throw new Error('An unrelated image inventory must never hold tar cleanup.'); return { code: 1, stdout: '', stderr: '' }
  } })).state, 'free')
  assert.deepEqual(tarCalls, ['lsof'])
  assert.equal((await observeArtifactOccupancy(join(root, 'other.zip'), { platform: 'darwin', run: async () => { throw new Error('Unsupported file must not query tools.') } })).state, 'unknown')
  const evidence = process.env.AGENTMUX_ARTIFACT_EVIDENCE
  let native = { platform: process.platform, status: 'not-tested', reason: 'Native tool assertions are qualified only on macOS; Linux leaf contracts above remain tested without requiring lsof.' }
  if (process.platform === 'darwin') {
    const nativeCommands = []
    const nativeRun = async (...args) => { const result = await runArtifactCommand(...args); nativeCommands.push({ command: args[0], args: args[1], code: result.code, signal: result.signal, timedOut: result.timedOut, error: result.error, stdoutSHA256: hash(result.stdout), stderrSHA256: hash(result.stderr) }); return result }
    const nativeFree = await observeArtifactOccupancy(input.archive, { run: nativeRun })
    const handle = await open(input.archive)
    let nativeOpen
    try { nativeOpen = await observeArtifactOccupancy(input.archive, { run: nativeRun }) } finally { await handle.close() }
    assert.equal(nativeFree.state, 'free'); assert.equal(nativeOpen.state, 'in-use')
    const nativeDmg = await observeArtifactOccupancy(dmg, { run: nativeRun })
    assert.equal(nativeDmg.state, 'free')
    native = { platform: process.platform, status: 'tested', tar: { nativeFree, nativeOpen }, dmg: { nativeFree: nativeDmg }, nativeCommands }
  }
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'native-occupancy.json'), JSON.stringify(native, null, 2)) }
}))

test('a hung owned observer is closed before unknown returns and the completed archive stays usable', { timeout: 10000 }, async () => fixture(async root => {
  const first = await publish(root, 'first'); await publish(root, 'second')
  let closed
  const result = await publish(root, 'third', path => observeArtifactOccupancy(path, { platform: 'linux', run: async (command, _args, _input, options) => {
    assert.equal(command, 'lsof'); assert.equal(options.timeoutMs, 5000)
    closed = await runArtifactCommand(process.execPath, ['-e', `process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)`], undefined, { timeoutMs: 200 })
    return closed
  } }))
  assert.equal(closed.timedOut, true); assert.equal(closed.signal, 'SIGKILL')
  const pid = Number(closed.stdout); assert(pid > 0)
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
  assert.equal(result.publication.status, 'published'); assert.equal(result.cleanup.retained.length, 1)
  assert.equal(result.cleanup.retained[0].state, 'unknown'); assert.equal(result.cleanup.retained[0].timedOut, true)
  assert(await exists(first.publication.path)); assert.equal(hash(await readFile(result.publication.path)), result.publication.sha256)
  let inherited, descendantPid
  const privateParent = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});child.unref();process.stdout.write(JSON.stringify({parent:process.pid,descendant:child.pid}));process.exit(0)`
  const inheritedUnknown = await observeArtifactOccupancy(first.publication.path, { platform: 'linux', run: async () => {
    inherited = await runArtifactCommand(process.execPath, ['-e', privateParent], undefined, { timeoutMs: 200 }); return inherited
  } })
  try {
    const ids = JSON.parse(inherited.stdout); descendantPid = ids.descendant
    assert.equal(inherited.code, 0); assert.equal(inherited.signal, null); assert.equal(inherited.timedOut, true)
    assert.equal(inheritedUnknown.state, 'unknown'); assert.equal(inheritedUnknown.timedOut, true)
    assert.throws(() => process.kill(ids.parent, 0), error => error.code === 'ESRCH')
    assert.doesNotThrow(() => process.kill(descendantPid, 0), 'Returning does not wait for or signal the inherited-pipe descendant')
  } finally {
    // This private descendant exits naturally. No process-tree management or signal is used.
    if (descendantPid) for (let attempt = 0; attempt < 60; attempt++) {
      try { process.kill(descendantPid, 0) } catch (error) { if (error.code === 'ESRCH') { descendantPid = null; break } throw error }
      await new Promise(done => setTimeout(done, 50))
    }
  }
  assert.equal(descendantPid, null, 'Private descendant naturally exited before fixture cleanup')
  const evidence = process.env.AGENTMUX_ARTIFACT_EVIDENCE
  if (evidence) await writeFile(join(evidence, 'observer-hang.json'), JSON.stringify({ childPid: pid, closed, retained: result.cleanup.retained, childGone: true, candidateUsable: true, inheritedPipes: { closed: inherited, observation: inheritedUnknown, descendantExitedNaturally: true } }, null, 2))
}))

const macPath = process.env.AGENTMUX_ARTIFACT_MAC_SOURCE ?? fileURLToPath(new URL('../apps/desktop/scripts/package-macos.mjs', import.meta.url))
const linuxPath = process.env.AGENTMUX_ARTIFACT_LINUX_SOURCE ?? fileURLToPath(new URL('../packages/core/scripts/linux-release/build.mjs', import.meta.url))
const macSource = await readFile(macPath, 'utf8'), linuxSource = await readFile(linuxPath, 'utf8')
const astFor = text => ts.createSourceFile('package.mjs', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functionBody = (text, name) => { const ast = astFor(text), found = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name); assert.equal(found.length, 1); assert(found[0].body.statements.length); return found[0].getText(ast) }
const macDeclarations = ['writeProgress', 'reportPackageStage', 'main'].map(name => functionBody(macSource, name)).join('\n')

async function macConsumer(root, { appOnly = false, install = false, installFailure = false, publicationFailure = false, fenceFailure = false } = {}) {
  const releaseRoot = join(root, 'release'), outputApp = join(releaseRoot, 'AgentMux.app'), outputDmg = join(releaseRoot, 'AgentMux.dmg')
  const events = [], outputs = [], noop = async () => {}, originalSource = { commit: 'fixture-commit', tree: 'fixture-tree', status: '' }
  let reads = 0, published
  const ports = { assert: (condition, message) => assert(condition, message), process: { argv: [], platform: 'darwin', arch: 'arm64', execPath: process.execPath, stdout: { write: value => outputs.push(value) }, stderr: { write: () => {} } },
    preflightMacosSigning: async () => ({ kind: 'ad-hoc' }), sourceIdentity: async () => ++reads > 1 && fenceFailure ? { ...originalSource, tree: 'later' } : originalSource,
    run: async command => { events.push(command); return { stdout: '1\n', stderr: '' } }, inspectElectronApplication: async () => ({ application: join(root, 'original.app') }),
    mkdtemp, mkdir, rename, rm, stat: lstat, dirname, join, tmpdir: () => root, repositoryRoot: root, desktopRoot: root, releaseRoot, outputApp, outputDmg, PRODUCT_NAME: 'AgentMux', manifest: { version: 'fixture' }, appOnly, installRequested: install || installFailure,
    brandApplication: noop, copyRuntimeApplication: noop, verifyIdentity: noop, verifyThirdPartyNotices: noop, auditBundle: noop, verifyWorkspaceMoveHelper: noop, verifyNativeDesktopCopy: noop,
    signAndVerifyMacosApplication: async () => ({ kind: 'ad-hoc' }), verifyNativeDesktopSigning: noop, verifyPackagedRuntime: noop, verifyLaunchServices: noop,
    sha256: async path => path === outputDmg ? hash(await readFile(path)) : 'a'.repeat(64),
    createDmg: async (app, dmg) => { await mkdir(app, { recursive: true }); await writeFile(dmg, 'Qualified private DMG fixture') }, verifyDmg: async () => events.push('verified'),
    installApplication: async () => { events.push('install'); if (installFailure) throw new Error('Original install failure'); return { ui: { status: 'committed' }, native: { status: 'unchanged' } } }, reportInstallTransaction: noop,
    preservePackageSmokeFailure: async () => ({ directory: root }),
    publishPackageArtifact: async input => { events.push('publish'); published = await publishPackageArtifact({ ...input, sha256: publicationFailure ? '0'.repeat(64) : input.sha256 }, { observeOccupancy: free }); return published } }
  // cp/branding/build/sign/OS qualification are expensive leaves; source main, filesystem publication and ordering are original.
  ports.brandApplication = async app => { await mkdir(app, { recursive: true }) }
  const main = new Function(...Object.keys(ports), `${macDeclarations}\nreturn main`)(...Object.values(ports))
  const error = await main().then(() => null, error => error)
  return { events, outputs, published, error }
}

test('original Mac main publishes only its fenced DMG before installation, and publication failure does not fail packaging', async () => fixture(async root => {
  let result = await macConsumer(root, { installFailure: true })
  assert.equal(result.error.message, 'Original install failure'); assert.equal(result.published.publication.status, 'published')
  assert(result.events.indexOf('verified') < result.events.indexOf('publish')); assert(result.events.indexOf('publish') < result.events.indexOf('install'))
  assert(await exists(result.published.publication.path))
  const publicationOutput = result.outputs.find(line => line.startsWith('package_artifact_publication='))
  assert.equal(JSON.parse(publicationOutput.slice('package_artifact_publication='.length)).path, result.published.publication.path)
  assert(result.outputs.some(line => line.startsWith('package_artifact_cleanup=')))
  result = await macConsumer(root, { publicationFailure: true, install: true }); assert.equal(result.error, null); assert.equal(result.published.publication.status, 'failed'); assert(result.events.includes('install'))
  assert(await exists(join(root, 'release/AgentMux.app')))
  result = await macConsumer(root, { appOnly: true }); assert.equal(result.error, null); assert.equal(result.published, undefined)
  result = await macConsumer(root, { fenceFailure: true }); assert(result.error); assert.equal(result.published, undefined)
}))

test('original Linux CLI publishes its build result; the reusable build owns its scratch partial and never publishes', async () => fixture(async root => {
  const ast = astFor(linuxSource), entry = ast.statements.filter(ts.isIfStatement).at(-1)
  assert(entry); const body = entry.thenStatement.getText(ast), input = await source(root), outputs = []
  let publications = 0
  const ports = { process: { argv: ['node', 'build.mjs', '--out', root], stdout: { write: value => outputs.push(value) } }, parse: () => ({ out: root }), isAbsolute: () => true,
    buildLinuxRelease: async () => ({ archive: input.archive, archiveSha256: input.sha256, version: 'fixture' }), resolve, packageRoot: join(root, 'packages/core'),
    publishPackageArtifact: async value => { publications++; return publishPackageArtifact(value, { observeOccupancy: free }) } }
  const originalWrite = process.stdout.write
  try {
    // Capture both the original CLI write port and any shared publisher global write in one stream.
    process.stdout.write = value => { outputs.push(String(value)); return true }
    await new Function(...Object.keys(ports), `return (async()=>${body})()`)(...Object.values(ports))
  } finally { process.stdout.write = originalWrite }
  assert.equal(publications, 1); assert.equal((await payloads(root)).length, 1)
  const result = JSON.parse(outputs.join(''))
  assert.equal(result.archive, input.archive); assert.equal(result.archiveSha256, input.sha256); assert.equal(result.version, 'fixture')
  assert.equal(result.artifacts.publication.status, 'published'); assert.equal(result.artifacts.publication.sha256, input.sha256)
  assert.equal(hash(await readFile(result.artifacts.publication.path)), input.sha256)
  assert.equal(JSON.parse(await readFile(result.artifacts.publication.receiptPath, 'utf8')).sha256, input.sha256)
  // Execute the entire original build function until its controlled tar producer fails, proving its scratch cleanup and private consumer boundary.
  let scratch, partial, published = false
  const buildSource = functionBody(linuxSource, 'buildLinuxRelease').replace(/^export /, '')
    .replace(/await import\(new URL\('\.\.\/\.\.\/dist\/portable-core-artifact\.js', import\.meta\.url\)\.href\)/, 'await ports.artifact()')
    .replace(/await import\(new URL\('\.\.\/\.\.\/dist\/remote-core-upgrade-programs\.js', import\.meta\.url\)\.href\)/, 'await ports.programs()')
    .replace(/await import\(new URL\('\.\.\/\.\.\/\.\.\/\.\.\/scripts\/package-dependencies\.mjs', import\.meta\.url\)\.href\)/, 'await ports.runtime()')
  assert(!buildSource.includes('import.meta'), 'All expensive build import leaves explicitly controlled')
  const noop = async () => {}
  const leafs = { ports: { artifact: async () => ({ createPortableCoreArtifact: async () => ({ archivePath: join(root, 'portable.tar.gz'), files: [] }) }), programs: async () => ({ STAGE_CORE: 'Fixture stage', SELECT_CORE_RELEASE: 'Fixture select' }), runtime: async () => ({ materializeRuntimeCore: noop }) },
    readFile: async () => '{"version":"fixture"}', join, resolve, packageRoot: root, mkdir, mkdtemp: async prefix => { scratch = await mkdtemp(prefix); return scratch },
    sourceRelease: async () => ({}), rename: noop, writeFile, cp: noop, chmod: noop, here: root, nodeArchive: async () => input.archive, NODE_VERSION: 'fixture', process,
    exec: async (_command, args) => { if (args.includes('-czf')) { partial = args[args.indexOf('-czf') + 1]; await writeFile(partial, 'Interrupted tar bytes'); throw new Error('Original tar failure') } },
    rm, sha: hash, publishPackageArtifact: async () => { published = true } }
  const build = new Function(...Object.keys(leafs), `return (${buildSource})`)(...Object.values(leafs))
  await assert.rejects(build({ out: join(root, 'private-out') }), /Original tar failure/)
  assert(partial.startsWith(scratch + '/')); assert.equal(await exists(scratch), false); assert.equal(await exists(partial), false); assert.equal(published, false)
}))

const evidence = process.env.AGENTMUX_ARTIFACT_EVIDENCE
if (evidence) {
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'source-inputs.json'), JSON.stringify({ publisher: { path: modulePath, sha256: hash(await readFile(modulePath)) }, mac: { path: macPath, sha256: hash(macSource), main: hash(macMain) }, linux: { path: linuxPath, sha256: hash(linuxSource), build: hash(functionBody(linuxSource, 'buildLinuxRelease')) } }, null, 2))
}
