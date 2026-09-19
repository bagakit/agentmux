import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readPackageIdentity } from './package-identity.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { desktopFixture } from './fixtures/settings-cli/desktop.mjs'

// A private consumer of an already signed DMG. It neither builds nor installs an App.
const [imageArgument, expectedCommit, evidenceArgument] = process.argv.slice(2)
assert.ok(imageArgument && evidenceArgument, 'Usage: verify-prompt-store-distribution.mjs <signed.dmg> <full-source-commit> <evidence-directory>')
assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/)
const exec = promisify(execFile), image = await realpath(imageArgument), evidence = resolve(evidenceArgument)
const root = await realpath(await mkdtemp('/tmp/amux-prompt-app-'))
const mount = join(root, 'mounted'), privateHome = join(root, 'home'), userData = join(root, 'user-data')
const storeFile = join(root, 'scope-sessions.json'), worker = join(root, 'worker.mjs')
const children = new Set(), connections = new Set()
const receipt = { schema: 'agentmux.prompt-store-distribution.v1', passed: false, phases: [], cleanup: {} }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
let mounted = false, desktop
await mkdir(evidence, { recursive: true })
const waitFor = async (label, read) => {
  const end = Date.now() + 20_000
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`Private distribution proof timed out: ${label}`)
}
const runWorker = async mode => {
  const result = await exec(process.execPath, [worker, storeFile, mode], { cwd: root, timeout: 20_000 })
  const values = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(values.length, 1); assert.equal(result.stderr, '')
  receipt.phases.push(values[0]); return values[0]
}
const quit = async () => {
  if (!desktop || desktop.child.exitCode !== null || desktop.child.signalCode !== null) return
  try { await desktop.main.evaluate("process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron').app.quit()") }
  catch (error) { receipt.quitReply = error.message }
  desktop.main.close(); desktop.cdp.close()
  await waitFor('actual Main exit', () => desktop.child.exitCode !== null || desktop.child.signalCode !== null)
  assert.equal(desktop.child.exitCode, 0); assert.equal(desktop.child.signalCode, null)
}
try {
  await Promise.all([mkdir(mount), mkdir(privateHome), mkdir(userData), mkdir(join(root, 'node_modules/@agentmux'), { recursive: true })])
  const attached = await exec('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image])
  mounted = true
  await writeFile(join(evidence, 'mount.log'), attached.stdout + attached.stderr)
  const appPath = await realpath(join(mount, 'AgentMux.app')), desktopRoot = join(appPath, 'Contents/Resources/app')
  const coreDirectory = join(desktopRoot, 'node_modules/@agentmux/core')
  const coreManifest = JSON.parse(await readFile(join(coreDirectory, 'package.json'), 'utf8'))
  assert.equal(coreManifest.name, '@agentmux/core')
  assert.equal(coreManifest.exports['.'].import, './dist/index.js')
  const coreEntry = await realpath(join(coreDirectory, coreManifest.exports['.'].import))
  assert.ok(coreEntry.startsWith(`${coreDirectory}/`))
  const signature = await exec('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  await writeFile(join(evidence, 'signature.log'), signature.stdout + signature.stderr)
  receipt.packageIdentity = await readPackageIdentity(appPath)
  assert.equal(receipt.packageIdentity.sourceCommit, expectedCommit)
  receipt.imageSha256 = digest(await readFile(image))
  receipt.executableSha256 = digest(await readFile(join(appPath, 'Contents/MacOS/AgentMux')))
  await symlink(join(desktopRoot, 'node_modules/@agentmux/core'), join(root, 'node_modules/@agentmux/core'))
  await copyFile(new URL('../../../packages/core/test/fixtures/prompt-store-lock-worker.mjs', import.meta.url), worker)
  const environment = { HOME: privateHome, CODEX_HOME: join(privateHome, 'codex'),
    AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'runtime', 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  const launch = desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor,
    packagedApplication: appPath })
  desktop = await launch('mounted-prompt-scope')
  // Import only the package inside the mounted application, in its real Browser/Main process.
  const identity = await desktop.main.evaluate(`(() => {
    const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))});
    const core = require(${JSON.stringify(coreEntry)}), electron = require('electron');
    globalThis.__promptScopeProof = { store: new core.AgentMuxFileAgentSessionStore(${JSON.stringify(storeFile)}), callbacks: 0 };
    return { pid: process.pid, type: process.type, executable: process.execPath, packaged: electron.app.isPackaged,
      versions: process.versions, core: require.resolve(${JSON.stringify(coreEntry)}) };
  })()`)
  assert.equal(identity.type, 'browser'); assert.equal(identity.packaged, true)
  assert.equal(await realpath(identity.executable), join(appPath, 'Contents/MacOS/AgentMux'))
  assert.ok((await realpath(identity.core)).startsWith(`${desktopRoot}/node_modules/`))
  receipt.main = identity
  const hold = async () => await desktop.main.evaluate(`(() => {
    const proof = globalThis.__promptScopeProof;
    proof.pending = proof.store.withPromptSubmission('packed-prompt-owner', async () => {
      proof.callbacks++; await new Promise(resolve => { proof.release = resolve });
    });
    return true;
  })()`)
  await hold()
  await waitFor('actual Main callback', () => desktop.main.evaluate('globalThis.__promptScopeProof.callbacks === 1'))
  const nodeBusy = await runWorker('contend')
  assert.equal(nodeBusy.phase, 'busy'); assert.equal(nodeBusy.callbacks, 1)
  const facts = await desktop.main.evaluate(`(() => {
    const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))});
    const fs = require('node:fs'), crypto = require('node:crypto'), coreRequire = require('node:module').createRequire(${JSON.stringify(coreEntry)});
    const addon = process.report.getReport().sharedObjects.filter(file => file.endsWith('fs-native-extensions.node'));
    if (addon.length !== 1) throw new Error('Expected the actual loaded native primitive');
    const inode = fs.statSync(${JSON.stringify(storeFile + '.prompt-locks') } + '/' + crypto.createHash('sha256').update('packed-prompt-owner').digest('hex'));
    const closure = {}; const visit = (name, resolver) => {
      if (closure[name]) return;
      const entry = fs.realpathSync(resolver.resolve(name)), path = require('node:path'); let directory = path.dirname(entry), manifest;
      while (directory !== path.dirname(directory)) {
        try { const candidate = JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8')); if (candidate.name === name) { manifest = candidate; break } }
        catch (error) { if (error.code !== 'ENOENT') throw error } directory = path.dirname(directory);
      }
      if (!manifest) throw new Error('Loader package identity missing');
      closure[name] = { version: manifest.version, entry, sha256: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') };
      for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, require('node:module').createRequire(entry));
    }; visit('fs-native-extensions',coreRequire);
    return { inode: { dev: inode.dev, ino: inode.ino }, addon: fs.realpathSync(addon[0]),
      addonSha256: crypto.createHash('sha256').update(fs.readFileSync(addon[0])).digest('hex'), closure };
  })()`)
  assert.deepEqual(facts.inode, nodeBusy.inode)
  assert.ok(facts.addon.startsWith(`${desktopRoot}/node_modules/`)); assert.equal(Object.keys(facts.closure).length, 6)
  assert.equal(facts.closure['fs-native-extensions'].version, '1.5.1')
  for (const descriptor of Object.values(facts.closure)) assert.ok(descriptor.entry.startsWith(`${desktopRoot}/node_modules/`))
  receipt.physical = facts
  await desktop.main.evaluate('(async () => { const proof = globalThis.__promptScopeProof; proof.release(); await proof.pending; return proof.callbacks })()')
  const released = await runWorker('acquire'); assert.deepEqual(released.inode, facts.inode)
  // Opposite ownership direction: actual Node holds; actual Main must neither
  // execute the contested callback nor block a different Session.
  const owner = spawn(process.execPath, [worker, storeFile, 'hold'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(owner)
  let output = '', errors = ''
  owner.stdout.on('data', data => { output += data }); owner.stderr.on('data', data => { errors += data })
  const closed = new Promise(resolve => owner.once('close', (code, signal) => resolve({ code, signal })))
  const held = await waitFor('actual Node owner', () => output.includes('\n') && JSON.parse(output.slice(0, output.indexOf('\n'))))
  assert.deepEqual(held.inode, facts.inode); assert.equal(held.addonSha256, facts.addonSha256)
  receipt.phases.push(held)
  const busy = await desktop.main.evaluate(`(async () => {
    const proof = globalThis.__promptScopeProof; let contested = 0, other = 0, code;
    try { await proof.store.withPromptSubmission('packed-prompt-owner', async () => { contested++ }) }
    catch (error) { code = error.code }
    await proof.store.withPromptSubmission('another-session', async () => { other++ });
    return { contested, other, code };
  })()`)
  assert.deepEqual(busy, { contested: 0, other: 1, code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
  receipt.phases.push({ phase: 'actual-main-busy', ...busy })
  owner.stdin.end('release\n'); assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(errors, '')
  children.delete(owner)
  const recovered = await desktop.main.evaluate(`(async () => {
    const proof = globalThis.__promptScopeProof; let failed = false;
    try { await proof.store.withPromptSubmission('packed-prompt-owner', async () => { throw new Error('deliberate callback failure') }) }
    catch (error) { failed = error.message === 'deliberate callback failure' }
    await proof.store.withPromptSubmission('packed-prompt-owner', async () => { proof.callbacks++ });
    return { failed, callbacks: proof.callbacks };
  })()`)
  assert.deepEqual(recovered, { failed: true, callbacks: 2 })
  receipt.phases.push({ phase: 'actual-main-error-released', ...recovered })
  await hold()
  await waitFor('Main owns before actual exit', () => desktop.main.evaluate('globalThis.__promptScopeProof.callbacks === 3'))
  assert.deepEqual((await runWorker('contend')).inode, facts.inode)
  await quit()
  assert.deepEqual((await runWorker('acquire')).inode, facts.inode)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const failures = []
  try { await quit() } catch (error) { failures.push(`Quit: ${error.message}`) }
  for (const connection of connections) connection.close()
  for (const child of children) {
    // A clean Main exit can leave its detached Runtime and Crashpad descendants.
    if (child.pid) {
      try { await stopProbeProcesses(child.pid, root) } catch (error) { failures.push(`Private child: ${error.message}`) }
    }
  }
  let remaining
  try { remaining = await listProbeProcesses(-1, root); assert.deepEqual(remaining, []) }
  catch (error) { failures.push(`Private process inventory: ${error.message}`) }
  if (remaining?.length === 0) {
    try {
      if (mounted) await exec('hdiutil', ['detach', mount])
      await rm(root, { recursive: true, force: true })
      receipt.cleanup.privateRootRemoved = true
    } catch (error) { failures.push(`Private mount: ${error.message}`) }
  }
  receipt.cleanup.failures = failures
  if (failures.length) receipt.passed = false
  receipt.cleanup.userApplicationOperated = false
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message ?? receipt.cleanup.failures?.join('; '))
console.log(JSON.stringify({ passed: true, actualElectronMain: receipt.main, cleanup: receipt.cleanup }))
