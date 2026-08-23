import { updateRoute } from '../src/shared/update-policy.ts'
import { hashTree } from './update-identity.mjs'
import { spawn } from 'node:child_process'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { materializeFileEditingFixture } from './file-editing-fixture.mjs'
import { classifyApplicationProcesses } from './package-process-scope.mjs'
import {
  assertPackageIdentity,
  canonicalInstallPath,
  createPackageIdentity,
  packageIdentityPath,
  readPackageIdentity
} from './package-identity.mjs'

const PRODUCT_NAME = 'AgentMux'
const BUNDLE_ID = 'dev.agentmux.desktop'
const require = createRequire(import.meta.url)
const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
const coreRoot = join(repositoryRoot, 'packages', 'core')
const demandRoot = join(repositoryRoot, 'packages', 'demand')
const releaseRoot = join(desktopRoot, 'release', 'mac')
const outputApp = join(releaseRoot, `${PRODUCT_NAME}.app`)
const outputDmg = join(
  releaseRoot,
  `${PRODUCT_NAME}-${manifest.version}-${process.platform}-${process.arch}.dmg`
)
const installRequested = process.argv.includes('--install')
// Runtime 变了就必须先做 Run/resume review——但 review 做完之后要有一条路能装。缺了这条路，
// 任何 ctxmux 升级都永远装不上：门就不再是"先 review"，而是"不许升级"。
// 这个参数带的是 review 记录的路径，不是一个裸开关；它会被读、被校验非空、被打进安装收据。
const runtimeReviewArgument = process.argv.find((argument) => argument.startsWith('--runtime-reviewed='))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run(command, args, options = {}) {
  const capture = options.capture ?? false
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] : 'inherit'
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKill
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
          forceKill.unref()
        }, options.timeoutMs)
      : undefined
    timeout?.unref()
    if (capture) {
      if (options.input !== undefined) child.stdin.end(options.input)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      if (timedOut) reject(new Error(`${command} timed out after ${options.timeoutMs}ms`))
      else if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${command} exited with ${signal ?? code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

async function pathExists(path) {
  return await lstat(path).then(() => true, () => false)
}

async function sourceIdentity() {
  const [commit, tree, status] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, capture: true }),
    run('git', ['write-tree'], { cwd: repositoryRoot, capture: true }),
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repositoryRoot,
      capture: true
    })
  ])
  const dirtyWorktree = status.stdout
    .split('\n')
    .filter((line) => line.length > 0 && (line.startsWith('??') || line[1] !== ' '))
    .join('\n')
  return {
    commit: commit.stdout.trim(),
    tree: tree.stdout.trim(),
    status: dirtyWorktree
  }
}

async function sha256(path) {
  return (await run('shasum', ['-a', '256', path], { capture: true }))
    .stdout.trim().split(/\s+/)[0]
}

async function plistReplace(path, key, type, value) {
  await run('plutil', ['-replace', key, `-${type}`, String(value), path], { capture: true })
}

async function plistRemove(path, key) {
  await run('plutil', ['-remove', key, path], { capture: true })
}

async function plistValue(path, key) {
  return (await run('plutil', ['-extract', key, 'raw', '-o', '-', path], { capture: true })).stdout.trim()
}

async function brandApplication(appPath) {
  const contents = join(appPath, 'Contents')
  const plist = join(contents, 'Info.plist')
  const resources = join(contents, 'Resources')
  const executable = join(contents, 'MacOS', PRODUCT_NAME)
  await rename(join(contents, 'MacOS', 'Electron'), executable)
  await plistReplace(plist, 'CFBundleDisplayName', 'string', PRODUCT_NAME)
  await plistReplace(plist, 'CFBundleName', 'string', PRODUCT_NAME)
  await plistReplace(plist, 'CFBundleIdentifier', 'string', BUNDLE_ID)
  await plistReplace(plist, 'CFBundleExecutable', 'string', PRODUCT_NAME)
  await plistReplace(plist, 'CFBundleIconFile', 'string', 'agentmux.icns')
  await plistReplace(plist, 'CFBundleShortVersionString', 'string', manifest.version)
  await plistReplace(plist, 'CFBundleVersion', 'string', manifest.version)
  await plistReplace(plist, 'LSApplicationCategoryType', 'string', 'public.app-category.developer-tools')
  for (const key of [
    'NSAppTransportSecurity',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) await plistRemove(plist, key)

  const helpers = [
    { suffix: '', idSuffix: '' },
    { suffix: ' (Renderer)', idSuffix: '.renderer' },
    { suffix: ' (GPU)', idSuffix: '.gpu' },
    { suffix: ' (Plugin)', idSuffix: '.plugin' }
  ]
  const frameworks = join(contents, 'Frameworks')
  for (const helper of helpers) {
    const sourceName = `Electron Helper${helper.suffix}`
    const targetName = `${PRODUCT_NAME} Helper${helper.suffix}`
    const targetApp = join(frameworks, `${targetName}.app`)
    await rename(join(frameworks, `${sourceName}.app`), targetApp)
    await rename(
      join(targetApp, 'Contents', 'MacOS', sourceName),
      join(targetApp, 'Contents', 'MacOS', targetName)
    )
    const helperPlist = join(targetApp, 'Contents', 'Info.plist')
    await plistReplace(helperPlist, 'CFBundleDisplayName', 'string', targetName)
    await plistReplace(helperPlist, 'CFBundleName', 'string', targetName)
    await plistReplace(helperPlist, 'CFBundleExecutable', 'string', targetName)
    await plistReplace(helperPlist, 'CFBundleIdentifier', 'string', `${BUNDLE_ID}.helper${helper.idSuffix}`)
  }

  await cp(join(desktopRoot, 'resources', 'icon.icns'), join(resources, 'agentmux.icns'))
  await rm(join(resources, 'electron.icns'), { force: true })
  await rm(join(resources, 'default_app.asar'), { force: true })
}

async function copyRuntimeApplication(appPath, source) {
  const resources = join(appPath, 'Contents', 'Resources')
  const appResources = join(resources, 'app')
  await mkdir(join(appResources, 'node_modules', '@agentmux'), { recursive: true })
  await cp(join(desktopRoot, 'out'), join(appResources, 'out'), { recursive: true })
  await cp(join(desktopRoot, 'resources'), join(appResources, 'resources'), { recursive: true })
  await cp(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), join(appResources, 'THIRD_PARTY_NOTICES.md'))
  await writeFile(join(appResources, 'package.json'), `${JSON.stringify({
    name: 'agentmux-desktop',
    productName: PRODUCT_NAME,
    version: manifest.version,
    private: true,
    type: 'module',
    main: 'out/main/index.js'
  }, null, 2)}\n`)
  await writeFile(
    packageIdentityPath(appPath),
    `${JSON.stringify(createPackageIdentity({
      sourceCommit: source.commit,
      sourceTree: source.tree,
      appVersion: manifest.version,
      platform: process.platform,
      arch: process.arch
    }), null, 2)}\n`
  )

  const coreRuntime = join(appResources, 'node_modules', '@agentmux', 'core')
  await mkdir(coreRuntime, { recursive: true })
  await cp(join(coreRoot, 'dist'), join(coreRuntime, 'dist'), { recursive: true })
  await cp(join(coreRoot, 'vendor'), join(coreRuntime, 'vendor'), { recursive: true })
  await cp(join(coreRoot, 'bin'), join(coreRuntime, 'bin'), { recursive: true })
  await writeFile(join(coreRuntime, 'bin', 'agentmux'), [
    '#!/bin/sh',
    'set -eu',
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    'export ELECTRON_RUN_AS_NODE=1',
    'exec "$launcher_dir/../../../../../../MacOS/AgentMux" "$launcher_dir/../dist/agentmux.js" "$@"'
  ].join('\n') + '\n', { mode: 0o755 })
  const coreManifest = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8'))
  await writeFile(join(coreRuntime, 'package.json'), `${JSON.stringify({
    name: coreManifest.name,
    version: coreManifest.version,
    type: coreManifest.type,
    main: coreManifest.main,
    exports: coreManifest.exports,
    engines: coreManifest.engines,
    os: coreManifest.os,
    cpu: coreManifest.cpu,
    license: coreManifest.license,
    repository: coreManifest.repository,
    bin: coreManifest.bin
  }, null, 2)}\n`)
  await materializeDependencies(
    coreRoot,
    coreManifest.dependencies ?? {},
    join(coreRuntime, 'node_modules')
  )
  const demandRuntime = join(appResources, 'node_modules', '@agentmux', 'demand')
  const demandManifest = JSON.parse(await readFile(join(demandRoot, 'package.json'), 'utf8'))
  await mkdir(demandRuntime, { recursive: true })
  await cp(join(demandRoot, 'dist'), join(demandRuntime, 'dist'), { recursive: true })
  await writeFile(join(demandRuntime, 'package.json'), `${JSON.stringify({
    name: demandManifest.name,
    version: demandManifest.version,
    type: demandManifest.type,
    main: demandManifest.main,
    exports: demandManifest.exports,
    bin: demandManifest.bin
  }, null, 2)}\n`)
  await materializeDependencies(
    demandRoot,
    demandManifest.dependencies ?? {},
    join(demandRuntime, 'node_modules')
  )
  await materializeDependency(desktopRoot, 'tldts', join(appResources, 'node_modules', 'tldts'))
  await materializeDependency(desktopRoot, 'zod', join(appResources, 'node_modules', 'zod'))
  const outBin = join(appResources, 'out', 'bin')
  await mkdir(outBin, { recursive: true })
  await cp(join(coreRoot, 'bin'), outBin, { recursive: true })
  await cp(join(coreRuntime, 'bin', 'agentmux'), join(outBin, 'agentmux'))
  await Promise.all([
    chmod(join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmux'), 0o755),
    chmod(join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd'), 0o755),
    chmod(join(coreRuntime, 'bin', 'agentmux'), 0o755),
    chmod(join(outBin, 'agentmux'), 0o755)
  ])
}

async function materializeDependencies(sourcePackage, dependencies, destination) {
  for (const packageName of Object.keys(dependencies).sort()) {
    await materializeDependency(
      sourcePackage,
      packageName,
      join(destination, ...packageName.split('/'))
    )
  }
}

async function materializeDependency(sourcePackage, packageName, destination) {
  const source = await resolvePackageRoot(sourcePackage, packageName)
  const packageManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: entry.isDirectory()
    })
  }
  await materializeDependencies(
    source,
    packageManifest.dependencies ?? {},
    join(destination, 'node_modules')
  )
}

async function resolvePackageRoot(sourcePackage, packageName) {
  let current = sourcePackage
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'))
    if (await pathExists(candidate)) return await realpath(candidate)
    if (current === repositoryRoot) break
    const parent = dirname(current)
    if (parent === current || relative(repositoryRoot, parent).startsWith(`..${sep}`)) break
    current = parent
  }
  throw new Error(`Could not resolve package root for ${packageName} from ${sourcePackage}.`)
}

async function auditBundleSymlinks(root) {
  const canonicalRoot = await realpath(root)
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        assert(!target.startsWith('/'), `Bundle contains an absolute symlink: ${path} -> ${target}`)
        const canonicalTarget = await realpath(path)
        const offset = relative(canonicalRoot, canonicalTarget)
        assert(offset !== '..' && !offset.startsWith(`..${sep}`), `Bundle symlink escapes the application: ${path}`)
      } else if (entry.isDirectory()) await visit(path)
    }
  }
  await visit(root)
}

async function auditRuntimeReferences(appPath, temporaryRoot) {
  const forbidden = [repositoryRoot, temporaryRoot]
  const runtimeRoot = join(appPath, 'Contents', 'Resources', 'app')
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || (await stat(path)).size > 2 * 1024 * 1024) continue
      const content = await readFile(path)
      if (content.includes(0)) continue
      const text = content.toString('utf8')
      for (const reference of forbidden) {
        assert(!text.includes(reference), `Packaged runtime contains a build-machine path in ${path}.`)
      }
    }
  }
  await visit(runtimeRoot)
}

async function verifyIdentity(appPath) {
  const contents = join(appPath, 'Contents')
  const plist = join(contents, 'Info.plist')
  assert(await plistValue(plist, 'CFBundleDisplayName') === PRODUCT_NAME, 'Packaged display name is wrong.')
  assert(await plistValue(plist, 'CFBundleExecutable') === PRODUCT_NAME, 'Packaged executable name is wrong.')
  assert(await plistValue(plist, 'CFBundleIdentifier') === BUNDLE_ID, 'Packaged bundle id is wrong.')
  assert(await plistValue(plist, 'CFBundleIconFile') === 'agentmux.icns', 'Packaged icon is wrong.')
  assert(!await pathExists(join(contents, 'Resources', 'default_app.asar')), 'Electron default app entered the package.')
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    assert(
      await pathExists(join(contents, 'Frameworks', `${PRODUCT_NAME} Helper${suffix}.app`)),
      `Packaged helper is missing: ${PRODUCT_NAME} Helper${suffix}.app`
    )
    assert(
      !await pathExists(join(contents, 'Frameworks', `Electron Helper${suffix}.app`)),
      `Unbranded Electron Helper remains: ${suffix || 'main'}`
    )
  }
}

async function verifyThirdPartyNotices(appPath) {
  const [source, packaged] = await Promise.all([
    readFile(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md')),
    readFile(join(appPath, 'Contents', 'Resources', 'app', 'THIRD_PARTY_NOTICES.md'))
  ])
  assert(
    source.equals(packaged),
    'Packaged third-party notices do not exactly match the repository notice.'
  )
}

async function verifyPackagedRuntime(appPath, verificationRoot, source) {
  const appResources = join(appPath, 'Contents', 'Resources', 'app')
  const packageIdentity = await readPackageIdentity(appPath)
  assertPackageIdentity(packageIdentity, {
    sourceCommit: source.commit,
    sourceTree: source.tree,
    appVersion: manifest.version,
    platform: process.platform,
    arch: process.arch
  })
  await verifyThirdPartyNotices(appPath)
  const coreRuntime = join(appResources, 'node_modules', '@agentmux', 'core')
  const binaryRoot = join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'bin')
  const workspaceMoveHelper = join(appResources, 'resources', 'bin', 'agentmux-workspace-move')
  const workspaceMoveRoot = join(verificationRoot, 'workspace-move-helper')
  const workspaceMoveSource = join(workspaceMoveRoot, 'source')
  const workspaceMoveDestination = join(workspaceMoveRoot, 'destination')
  await Promise.all([
    mkdir(workspaceMoveSource, { recursive: true }),
    mkdir(workspaceMoveDestination, { recursive: true })
  ])
  const workspaceMoveHelperInfo = await stat(workspaceMoveHelper)
  assert(
    workspaceMoveHelperInfo.isFile() && (workspaceMoveHelperInfo.mode & 0o111) !== 0,
    'Packaged Workspace move helper is missing or not executable.'
  )
  const workspaceMoveRootInfo = await stat(workspaceMoveRoot, { bigint: true })
  const workspaceMoveArgs = (source, destination) => [
    workspaceMoveRoot,
    workspaceMoveRootInfo.dev.toString(),
    workspaceMoveRootInfo.ino.toString(),
    source,
    destination
  ]
  await writeFile(join(workspaceMoveSource, 'moved.txt'), 'packaged helper bytes')
  await run(workspaceMoveHelper, workspaceMoveArgs('source/moved.txt', 'destination/moved.txt'), { capture: true })
  assert(
    await readFile(join(workspaceMoveDestination, 'moved.txt'), 'utf8') === 'packaged helper bytes',
    'Packaged Workspace move helper did not move the source bytes.'
  )
  await Promise.all([
    writeFile(join(workspaceMoveSource, 'collision.txt'), 'source bytes'),
    writeFile(join(workspaceMoveDestination, 'collision.txt'), 'destination bytes')
  ])
  let collisionError
  try {
    await run(
      workspaceMoveHelper,
      workspaceMoveArgs('source/collision.txt', 'destination/collision.txt'),
      { capture: true }
    )
  } catch (error) {
    collisionError = error
  }
  assert(
    collisionError instanceof Error && collisionError.message.includes('errno=17'),
    'Packaged Workspace move helper did not report the destination collision.'
  )
  assert(
    await readFile(join(workspaceMoveSource, 'collision.txt'), 'utf8') === 'source bytes' &&
      await readFile(join(workspaceMoveDestination, 'collision.txt'), 'utf8') === 'destination bytes',
    'Packaged Workspace move helper changed bytes after a destination collision.'
  )
  process.stdout.write('packaged_workspace_move_helper=passed\n')
  const [cli, daemon, agentmux] = await Promise.all([
    run(join(binaryRoot, 'ctxmux'), ['--version'], { capture: true }),
    run(join(binaryRoot, 'ctxmuxd'), ['--version'], { capture: true }),
    run(join(coreRuntime, 'bin', 'agentmux'), ['--version'], {
      capture: true,
      env: { PATH: '/usr/bin:/bin' }
    })
  ])
  // The vendored CtxMux manifest is the single SHA-verified identity source: packages/core/src/
  // runtime-paths.ts pins its digest as CTXMUX_MANIFEST_SHA256, ctxmux-run-adapter.ts re-verifies
  // that digest (and manifest.source.commit / manifest.product.version) at load, and the mounted
  // smoke launch below boots that exact runtime. So derive every ctxmux/ctxmuxd expectation from
  // the packaged manifest rather than hand-copying '0.1.0' / 'protocol 14' / the 40-char commit —
  // a hand-copied literal here would silently freeze when the vendored artifact is bumped, and this
  // gate would then either assert a stale identity or (worse) pass against the wrong one. First tie
  // the packaged manifest to the pinned source bytes; a byte-identical copy transfers the whole
  // pinned identity (commit, tree, version, protocol) in one check, strictly stronger than the old
  // single-field commit literal.
  const [packagedCtxmuxManifestBytes, sourceCtxmuxManifestBytes] = await Promise.all([
    readFile(join(coreRuntime, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json')),
    readFile(join(coreRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json'))
  ])
  assert(
    packagedCtxmuxManifestBytes.equals(sourceCtxmuxManifestBytes),
    'Packaged ctxmux manifest is not byte-identical to the pinned source artifact.'
  )
  const ctxmuxManifest = JSON.parse(packagedCtxmuxManifestBytes.toString('utf8'))
  const ctxmuxVersion = ctxmuxManifest.product.version
  const ctxmuxProtocol = ctxmuxManifest.product.protocol
  assert(cli.stdout.trim() === `ctxmux ${ctxmuxVersion} (protocol ${ctxmuxProtocol})`, 'Packaged ctxmux identity is wrong.')
  // ctxmuxd states one fact more than the CLI: the handoff schema it can adopt across an
  // exec-in-place upgrade. That is why the daemon's parenthesis is open-ended and the CLI's is not
  // — an upgrade target that cannot declare its schema is refused before the exec, so the daemon
  // has to publish it somewhere a not-yet-running binary can be asked, and `--version` is that
  // channel. Requiring `,` or `)` after the protocol keeps this from degrading into a prefix match,
  // which would accept `protocol 170` as `protocol 17`.
  const daemonIdentity = daemon.stdout.trim()
  const daemonPrefix = `ctxmuxd ${ctxmuxVersion} (protocol ${ctxmuxProtocol}`
  const daemonDelimiter = daemonIdentity.slice(daemonPrefix.length, daemonPrefix.length + 1)
  assert(
    daemonIdentity.startsWith(daemonPrefix) && (daemonDelimiter === ',' || daemonDelimiter === ')'),
    'Packaged ctxmuxd identity is wrong.'
  )
  assert(agentmux.stdout.trim() === 'agentmux 0.1.0', 'Packaged AgentMux CLI cannot use the embedded runtime.')
}

async function scopedProcesses(appPath) {
  const canonicalAppPath = await realpath(appPath)
  const executable = join(canonicalAppPath, 'Contents', 'MacOS', PRODUCT_NAME)
  const helperRoot = join(canonicalAppPath, 'Contents', 'Frameworks') + sep
  const result = await run('ps', ['-axo', 'pid=,command='], { capture: true })
  return classifyApplicationProcesses(result.stdout, { executable, helperRoot })
}

// The bundle's *serving* processes: main + renderer/GPU/utility helpers. A
// detached crash-reporter helper is excluded — it serves no UI and keeps no
// old code alive — so a stale one no longer blocks quit/relaunch/survivor. See
// package-process-scope.mjs for why only the crash reporter is carved out.
async function processIdsForApplication(appPath) {
  return (await scopedProcesses(appPath)).serving
}

async function waitForProcessExit(findProcessIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = await findProcessIds()
  while (remaining.length > 0) {
    const delay = Math.min(20, deadline - Date.now())
    if (delay <= 0) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
    remaining = await findProcessIds()
  }
  return remaining
}

async function waitForPath(path, deadline) {
  while (true) {
    if (Date.now() > deadline) return false
    const exists = await pathExists(path)
    if (Date.now() > deadline) return false
    if (exists) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(20, remaining)))
  }
}

function signalProcessIds(processIds, signal) {
  const errors = []
  for (const pid of processIds) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        errors.push(new Error(`Could not send ${signal} to scoped process ${pid}`, { cause: error }))
      }
    }
  }
  return errors
}

async function cleanupProcessScope(scope, findProcessIds) {
  const errors = []
  let processIds
  try {
    processIds = await findProcessIds()
  } catch (error) {
    errors.push(new Error(`Launch smoke ${scope} cleanup PID query failed`, { cause: error }))
    return errors
  }
  errors.push(...signalProcessIds(processIds, 'SIGTERM'))

  let remaining
  try {
    remaining = await waitForProcessExit(findProcessIds, 5_000)
  } catch (error) {
    errors.push(new Error(`Launch smoke ${scope} cleanup exit wait failed`, { cause: error }))
    return errors
  }
  if (remaining.length === 0) return errors

  errors.push(new Error(`Launch smoke ${scope} cleanup required SIGKILL for PIDs ${remaining.join(', ')}`))
  errors.push(...signalProcessIds(remaining, 'SIGKILL'))
  try {
    remaining = await waitForProcessExit(findProcessIds, 2_000)
  } catch (error) {
    errors.push(new Error(`Launch smoke ${scope} cleanup forced-exit wait failed`, { cause: error }))
    return errors
  }
  if (remaining.length > 0) {
    errors.push(new Error(`Launch smoke ${scope} processes survived scoped cleanup: ${remaining.join(', ')}`))
  }
  return errors
}

async function verifyLaunchServices(appPath, verificationRoot) {
  const canonicalAppPath = await realpath(appPath)
  const readyFile = join(verificationRoot, 'desktop-ready.json')
  const fileEditingReport = join(verificationRoot, 'workspace-file-editing.json')
  const userData = join(verificationRoot, 'user-data')
  const workspace = join(verificationRoot, 'workspace')
  const alternateWorkspace = join(verificationRoot, 'alternate-workspace')
  const stdoutPath = join(verificationRoot, 'desktop-stdout.log')
  const stderrPath = join(verificationRoot, 'desktop-stderr.log')
  const runtimeRoot = await mkdtemp(join('/private/tmp', `amx-smoke-${process.getuid()}-`))
  const endpointPath = join(runtimeRoot, 'ctxmux.sock')
  const ownerReceiptPath = join(runtimeRoot, 'owner.json')
  const executable = join(canonicalAppPath, 'Contents', 'MacOS', PRODUCT_NAME)
  const daemonEntrypoint = join(
    canonicalAppPath,
    'Contents',
    'Resources',
    'app',
    'node_modules',
    '@agentmux',
    'core',
    'vendor',
    'ctxmux',
    'darwin-arm64',
    'bin',
    'ctxmuxd'
  )
  await materializeFileEditingFixture({ userData, workspace, alternateWorkspace })
  const before = new Set(await processIdsForApplication(canonicalAppPath))
  const ownedApplicationPids = async () => (
    (await processIdsForApplication(canonicalAppPath)).filter((pid) => !before.has(pid))
  )
  const ownedDaemonPids = async () => {
    const processes = await run('ps', ['-axo', 'pid=,command='], { capture: true })
    return processes.stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
      if (!match || !match[2].includes(daemonEntrypoint) || !match[2].includes(endpointPath)) return []
      return [Number(match[1])]
    })
  }
  let verificationError
  let verificationStage = 'launch-request'
  const verificationDeadline = Date.now() + 180_000
  try {
    await run('open', [
      '-n',
      '-j',
      '--stdout', stdoutPath,
      '--stderr', stderrPath,
      '--env', `AGENTMUX_DESKTOP_USER_DATA=${userData}`,
      '--env', 'AGENTMUX_DISABLE_CRASH_REPORTER=1',
      '--env', `AGENTMUX_RUNTIME_DIRECTORY=${runtimeRoot}`,
      '--env', `AGENTMUX_DESKTOP_READY_FILE=${readyFile}`,
      '--env', `AGENTMUX_DESKTOP_FILE_EDITING_REPORT=${fileEditingReport}`,
      canonicalAppPath
    ], { capture: false, timeoutMs: Math.max(1, verificationDeadline - Date.now()) })
    verificationStage = 'ready-receipt'
    assert(
      await waitForPath(readyFile, verificationDeadline),
      'Packaged Desktop timed out waiting for a ready receipt.'
    )
    const ready = JSON.parse(await readFile(readyFile, 'utf8'))
    assert(ready.productName === PRODUCT_NAME, 'LaunchServices started an incorrectly branded application.')
    assert(ready.packaged === true, 'LaunchServices did not start the packaged application.')
    assert(
      await realpath(ready.executable) === executable,
      'LaunchServices ready receipt did not come from the exact relocated application.'
    )
    verificationStage = 'file-editing-report'
    assert(
      await waitForPath(fileEditingReport, verificationDeadline),
      'Mounted Desktop timed out waiting for the file editing report.'
    )
    const fileEditing = JSON.parse(await readFile(fileEditingReport, 'utf8'))
    assert(fileEditing.ok === true, `Mounted Desktop file editing E2E failed: ${fileEditing.error ?? 'unknown error'}`)
    assert(fileEditing.schema === 'agentmux.workspace-file-editing-e2e.v2', 'Mounted Desktop emitted the wrong file editing report schema.')
    assert(
      fileEditing.phases?.saveGeneration?.disk === 'bravo' &&
        fileEditing.phases.saveGeneration.editor === 'charlie' &&
        fileEditing.phases.saveGeneration.state === 'dirty',
      'Mounted Desktop did not preserve input made during save.'
    )
    assert(
      fileEditing.phases?.writeError?.disk === 'lima' &&
        fileEditing.phases.writeError.editor === 'mike' &&
        fileEditing.phases.writeError.state === 'write-error',
      'Mounted Desktop did not preserve original bytes and draft after replace failure.'
    )
    assert(
      fileEditing.phases?.explorer?.pointerMove?.moved === true &&
        fileEditing.phases.explorer.pointerMove.fileOverlayOnly === true &&
        fileEditing.phases.explorer.invalidDrop?.blocked === true,
      'Mounted Desktop did not prove PointerSensor move, invalid drop, and Workbench overlay isolation.'
    )
    assert(
      fileEditing.phases?.explorer?.hover?.expanded === true &&
        fileEditing.phases.explorer.hover.cancelledStayedCollapsed === true,
      'Mounted Desktop did not prove hover expansion and drag-cancel cleanup.'
    )
    assert(
      fileEditing.phases?.explorer?.menu?.shiftF10Opened === true &&
        fileEditing.phases.explorer.menu.moved === true &&
        fileEditing.phases.explorer.menu.singleSelection === true,
      'Mounted Desktop did not prove Radix and Shift+F10 single-item Move behavior.'
    )
    assert(
      fileEditing.phases?.explorer?.workspaceRevisit?.preserved === true &&
        fileEditing.phases.explorer.workspaceRevisit.settledWithoutLoop === true &&
        fileEditing.phases.explorer.workspaceRevisit.explorerProjectionNotifications?.total === 0,
      'Mounted Desktop did not preserve the zero-notification Explorer projection across Workspace A to B to A.'
    )
    assert(
      fileEditing.phases?.explorer?.menu?.workspaceRace?.alternateTreeUnchanged === true &&
        fileEditing.phases.explorer.menu.workspaceRace.stalePrimaryReadsStarted === 0 &&
        fileEditing.phases.explorer.menu.workspaceRace.primaryRecovered === true &&
        fileEditing.phases.explorer.menu.workspaceRace.explorerProjectionNotifications?.total === 1,
      'Mounted Desktop did not reject the stale primary refresh or recover it from its Workspace owner.'
    )
    verificationStage = 'runtime-owner-receipt'
    const ownerReceipt = JSON.parse(await readFile(ownerReceiptPath, 'utf8'))
    assert(
      await realpath(ownerReceipt.daemonPath) === await realpath(daemonEntrypoint) &&
        ownerReceipt.socketPath === endpointPath,
      'LaunchServices did not start the exact packaged CtxMux runtime.'
    )
    verificationStage = 'application-exit'
    const exitBudget = verificationDeadline - Date.now()
    assert(exitBudget > 0, 'Packaged Desktop exhausted the lifecycle budget before exit observation.')
    const remainingApplicationPids = await waitForProcessExit(
      ownedApplicationPids,
      exitBudget
    )
    assert(Date.now() <= verificationDeadline, 'Packaged Desktop exit observation exceeded the lifecycle budget.')
    assert(
      remainingApplicationPids.length === 0,
      `Packaged Desktop application or observer processes did not exit within the lifecycle budget: ${remainingApplicationPids.join(', ')}`
    )
  } catch (error) {
    const [readyExists, reportExists, ownerReceiptExists] = await Promise.all([
      pathExists(readyFile),
      pathExists(fileEditingReport),
      pathExists(ownerReceiptPath)
    ])
    let reportReadError
    const reportText = await readFile(fileEditingReport, 'utf8').catch((readError) => {
      reportReadError = readError instanceof Error ? readError.message : String(readError)
      return null
    })
    let ownerReceiptReadError
    const ownerReceiptText = await readFile(ownerReceiptPath, 'utf8').catch((readError) => {
      ownerReceiptReadError = readError instanceof Error ? readError.message : String(readError)
      return null
    })
    const stderr = await readFile(stderrPath, 'utf8').catch(() => '')
    let report
    let reportParseError
    if (reportText !== null) {
      try {
        report = JSON.parse(reportText)
      } catch (parseError) {
        reportParseError = parseError instanceof Error ? parseError.message : String(parseError)
      }
    }
    let ownerReceipt
    let ownerReceiptParseError
    let ownerIdentity = ownerReceiptExists ? 'unavailable' : 'missing'
    if (ownerReceiptText !== null) {
      try {
        ownerReceipt = JSON.parse(ownerReceiptText)
      } catch (parseError) {
        ownerReceiptParseError = parseError instanceof Error ? parseError.message : String(parseError)
      }
    }
    if (ownerReceipt) {
      try {
        ownerIdentity =
          await realpath(ownerReceipt.daemonPath) === await realpath(daemonEntrypoint) &&
            ownerReceipt.socketPath === endpointPath
            ? 'match'
            : 'mismatch'
      } catch (identityError) {
        ownerIdentity = `unavailable:${identityError instanceof Error ? identityError.message : String(identityError)}`
      }
    }
    let applicationPids = 'unavailable'
    try {
      const scopedPids = await ownedApplicationPids()
      applicationPids = scopedPids.length > 0 ? scopedPids.join(',') : 'none'
    } catch (processError) {
      applicationPids = `unavailable:${processError instanceof Error ? processError.message : String(processError)}`
    }
    verificationError = new Error([
      `Mounted Desktop ${verificationStage} stage failed: ${error instanceof Error ? error.message : String(error)}`,
      [
        `ready=${readyExists ? 'present' : 'missing'}`,
        `report=${reportExists ? 'present' : 'missing'}`,
        `report_read_error=${reportReadError ?? 'none'}`,
        `report_ok=${typeof report?.ok === 'boolean' ? String(report.ok) : 'unknown'}`,
        `report_error=${report?.error === undefined ? 'none' : JSON.stringify(report.error)}`,
        `report_parse_error=${reportParseError ?? 'none'}`,
        `owner_receipt=${ownerReceiptExists ? 'present' : 'missing'}`,
        `owner_read_error=${ownerReceiptReadError ?? 'none'}`,
        `owner_parse=${!ownerReceiptExists ? 'missing' : ownerReceipt ? 'ok' : 'error'}`,
        `owner_parse_error=${ownerReceiptParseError ?? 'none'}`,
        `owner_identity=${ownerIdentity}`,
        `scoped_application_pids=${applicationPids}`,
        `stderr=${stderr.trim() ? JSON.stringify(stderr.trim()) : 'empty'}`
      ].join(' ')
    ].join('\n'), { cause: error })
  }

  const cleanupErrors = [
    ...await cleanupProcessScope('application', ownedApplicationPids),
    ...await cleanupProcessScope('daemon', ownedDaemonPids)
  ]

  try {
    await rm(runtimeRoot, { recursive: true, force: true })
    assert(!await pathExists(endpointPath), 'Launch smoke ctxmuxd endpoint survived scoped cleanup.')
  } catch (error) {
    cleanupErrors.push(error)
  }

  const failures = [verificationError, ...cleanupErrors].filter(Boolean)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Mounted Desktop verification did not reach a clean terminal state')
  }
  process.stdout.write('mounted_desktop_interactions=passed\n')
}

async function createDmg(appPath, dmgPath, temporaryRoot) {
  const dmgRoot = join(temporaryRoot, 'dmg-root')
  await mkdir(dmgRoot)
  // `cp -cR` falls back to a very slow cross-volume copy on macOS when the staging root is under
  // /private/tmp. `ditto` is the same resource-preserving primitive used for installation and keeps
  // this DMG staging step bounded without changing the bundle bytes or symlink policy.
  await run('ditto', ['--rsrc', '--extattr', appPath, join(dmgRoot, basename(appPath))], { capture: true })
  await symlink('/Applications', join(dmgRoot, 'Applications'))
  await run('hdiutil', [
    'create',
    '-volname', PRODUCT_NAME,
    '-srcfolder', dmgRoot,
    '-format', 'UDZO',
    '-ov',
    dmgPath
  ], { capture: true })
  await detachCreatedImage(dmgPath)
  await run('hdiutil', ['verify', dmgPath], { capture: true })
}

async function detachCreatedImage(imagePath) {
  const info = await run('hdiutil', ['info', '-plist'], { capture: true })
  const json = await run('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    capture: true,
    input: info.stdout
  })
  const images = JSON.parse(json.stdout).images ?? []
  const canonicalImagePath = await realpath(imagePath)
  for (const image of images) {
    if (!image['image-path'] || await realpath(image['image-path']) !== canonicalImagePath) continue
    const device = image['system-entities']
      ?.find((entity) => typeof entity['dev-entry'] === 'string')?.['dev-entry']
    assert(device, `Created DMG is busy without an owned device: ${imagePath}`)
    await run('hdiutil', ['detach', device], { capture: true })
  }
}

async function verifyDmg(dmgPath, temporaryRoot, source) {
  const mountPoint = join(temporaryRoot, 'mounted-dmg')
  const verificationRoot = join(temporaryRoot, 'verification')
  const applicationsRoot = join(verificationRoot, 'Applications')
  const installedApp = join(applicationsRoot, `${PRODUCT_NAME}.app`)
  await mkdir(mountPoint)
  await mkdir(applicationsRoot, { recursive: true })
  await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath], { capture: true })
  try {
    const entries = (await readdir(mountPoint)).sort()
    assert(entries.includes(`${PRODUCT_NAME}.app`), 'DMG does not contain AgentMux.app.')
    assert(entries.includes('Applications'), 'DMG does not contain the Applications link.')
    await run('ditto', [join(mountPoint, `${PRODUCT_NAME}.app`), installedApp], { capture: true })
  } finally {
    await run('hdiutil', ['detach', mountPoint], { capture: true })
  }
  await verifyIdentity(installedApp)
  await auditBundleSymlinks(installedApp)
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp], { capture: true })
  await verifyPackagedRuntime(installedApp, verificationRoot, source)
  await verifyLaunchServices(installedApp, verificationRoot)
}

/**
 * 让已装路径上正在跑的实例退出，并回报它是否存在过。
 *
 * 先 `osascript … quit` 走 Cmd+Q 那条路：桌面端在退出时 flush 布局状态（见 registerUnloadFlush），
 * 直接 SIGKILL 会丢掉用户当前的 Tab/Region 布局。请求退出后等进程真的消失，超时才升级到信号——
 * `signalProcessIds` 自己会做 SIGTERM→SIGKILL 的升级。
 *
 * `osascript` 失败**不是**错误：app 没在跑、没注册到 LaunchServices、AppleScript 被策略拦，都会让它
 * 非零退出，而这些情况下"让它退出"这个目标本来就已经达成或无从达成。判据是**进程还在不在**，不是
 * 那条命令的退出码。
 *
 * 只对**服务着这份包**的进程（主进程 + renderer/GPU/utility helper）设判据。脱钩的 crash-reporter
 * helper（app 退出后被 launchd 收养，PPID 1，不 flush 任何状态、也无法服务 UI）会被跳过——但会打印
 * 出来，因为一个残留的它曾经让每一次后续安装都卡住（2026-09-13 实测 pid 1033）。跳过而不是杀掉：安装
 * 路径不发信号是这里的既定承诺（见 package-install-restart.test.ts），交给 OS 回收更安全。
 */
async function quitInstalledApplication(appPath) {
  const { serving: running, crashReporter } = await scopedProcesses(appPath)
  if (crashReporter.length > 0) {
    process.stdout.write(`ignored_detached_crash_reporter=${crashReporter.join(',')} (orphaned Electron crash handler; serves no bundle, left for the OS to reap)\n`)
  }
  if (running.length === 0) return { wasRunning: false, pids: [] }
  await run('osascript', ['-e', `quit app id "${BUNDLE_ID}"`], { capture: true, timeoutMs: 15_000 })
    .catch(() => undefined)
  let remaining = await waitForProcessExit(() => processIdsForApplication(appPath), 20_000)
  assert(remaining.length === 0,
    `Application has not exited gracefully (pids ${remaining.join(', ')}). Installation stopped; no processes were force-killed. Finish or save current work before retrying.`)
  return { wasRunning: true, pids: running }
}

/**
 * 装完必须交付**一个跑着新包的进程**，不是只换掉磁盘上的目录。
 *
 * 为什么这一步是承重的：安装用 `rename` 原子换目录，旧的整份被 `mv` 进 `~/.Trash`。已运行的进程按
 * **inode** 持有它打开的文件，目录改名不影响那些 inode——于是旧实例会从垃圾桶里**静默继续跑**，
 * 零报错零提示。此时磁盘上每一项身份校验（package-identity、bundle 内容）都通过，而用户面前那个
 * 窗口跑的仍是旧代码。2026-09-01 实测：主进程 18:35 启动、安装 21:54，用户按新包的预期去点链接，
 * 看到的是三小时前那份的行为，三层磁盘验证一条都没能发现。
 *
 * 所以这里在 rename 之后重新拉起，并把新进程的 pid 打印出来当凭据：安装那步随后会断言"跑在已装
 * 路径上的每一个进程都在这份 pid 名单里"，也就是没有任何一个更早的实例活下来。热更新是我们自己的
 * 设计前提，重装就该走完这条路，不留"要不要重启"这种由调用方决定的开关。
 */
async function relaunchInstalledApplication(appPath) {
  await run('open', ['-a', appPath], { capture: false, timeoutMs: 60_000 })
  const deadline = Date.now() + 60_000
  let pids = []
  while (Date.now() < deadline) {
    pids = await processIdsForApplication(appPath)
    if (pids.length > 0) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assert(
    pids.length > 0,
    'The freshly installed application did not start; nothing is serving the new bundle for verification.'
  )
  return pids
}

async function installApplication(appPath) {
  const currentPath = canonicalInstallPath(homedir())
  let runtimeReviewPath
  if (await pathExists(currentPath)) {
    const runtimeRelative = 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux'
    const [currentRuntime, candidateRuntime] = await Promise.all([
      hashTree(currentPath, [runtimeRelative]), hashTree(appPath, [runtimeRelative])
    ])
    if (updateRoute({ shell: '', ctxmux: currentRuntime }, { shell: '', ctxmux: candidateRuntime }) === 'runtime-review') {
      // Runtime 变了：新 artifact 派生出新的 endpoint，旧 daemon 上的 Run 不会被接管。这一步要求
      // 先把它们盘清楚——哪些能自己 resume、哪些不能——并把结论落到磁盘上。
      //
      // 判据是**那份记录读得到且非空**，不是"命令行上打了个开关"。裸 `--force` 只证明有人想跳过
      // 检查；一份读得出内容的 review 记录才证明检查真的做了，而且装完之后还能回去看。
      assert(runtimeReviewArgument,
        'CtxMux runtime differs; the Runs on the running daemon will not carry over. Record which Runs can resume on their own, then pass --runtime-reviewed=<path to that record>. No running application was changed.')
      runtimeReviewPath = runtimeReviewArgument.slice('--runtime-reviewed='.length)
      assert(runtimeReviewPath, '--runtime-reviewed= needs the path to the Run/resume review, not an empty value.')
      const review = await readFile(runtimeReviewPath, 'utf8').catch(() => null)
      assert(review !== null, `Cannot read the Run/resume review at ${runtimeReviewPath}; nothing proves the review happened.`)
      assert(review.trim().length > 0, `The Run/resume review at ${runtimeReviewPath} is empty.`)
    }
  }

  const destination = canonicalInstallPath(homedir())
  const applicationsRoot = dirname(destination)
  const trashRoot = join(homedir(), '.Trash')
  const next = join(applicationsRoot, `.${PRODUCT_NAME}.install-${process.pid}.app`)
  await mkdir(applicationsRoot, { recursive: true })
  await rm(next, { recursive: true, force: true })
  await run('ditto', [appPath, next], { capture: true })
  await run('codesign', ['--verify', '--deep', '--strict', next], { capture: true })
  // 换目录之前先请旧实例退出。放在 ditto/codesign 之后，是为了让候选包先被证明可用——候选不合格时
  // 不该白关掉用户正在用的窗口。
  const previouslyInstalled = await pathExists(destination)
  const quitOutcome = previouslyInstalled
    ? await quitInstalledApplication(destination)
    : { wasRunning: false, pids: [] }
  let previousInstall
  if (previouslyInstalled) {
    await mkdir(trashRoot, { recursive: true })
    const trashName = `${PRODUCT_NAME}-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.app`
    previousInstall = join(trashRoot, trashName)
    await rename(destination, previousInstall)
  }
  try {
    await rename(next, destination)
  } catch (error) {
    // The old installation must remain the active one if the final cutover fails. Restore it
    // from Trash before surfacing the failure; user data is never part of this rollback.
    if (previousInstall && await pathExists(previousInstall)) {
      await rename(previousInstall, destination).catch((restoreError) => {
        throw new AggregateError([error, restoreError], 'Could not install candidate or restore the previous application')
      })
    }
    throw error
  }
  process.stdout.write(`installed_app=${destination}\n`)
  if (runtimeReviewPath) process.stdout.write(`runtime_review=${runtimeReviewPath}\n`)
  if (previousInstall) process.stdout.write(`previous_install_trashed=${previousInstall}\n`)
  process.stdout.write(`quit_previous_instance=${quitOutcome.wasRunning ? quitOutcome.pids.join(',') : 'not_running'}\n`)
  const relaunched = await relaunchInstalledApplication(destination)
  process.stdout.write(`relaunched_pids=${relaunched.join(',')}\n`)
  // 交付判据：装完之后，跑在已装路径上的每一个进程都必须是**这次**拉起的。留下任何一个更早的
  // 进程，就意味着"用户点的那个窗口"可能仍在服务上一份包——那正是这段代码存在的原因。
  const survivors = (await processIdsForApplication(destination)).filter((pid) => !relaunched.includes(pid))
  assert(
    survivors.length === 0,
    `Processes from a previous installation are still running (pids ${survivors.join(', ')}); they keep serving the previous bundle even though the directory was replaced.`
  )
}

async function main() {
  assert(process.platform === 'darwin', 'macOS packaging must run on macOS.')
  assert(process.arch === 'arm64', `AgentMux currently packages only darwin-arm64, not darwin-${process.arch}.`)
  const initialSource = await sourceIdentity()
  assert(
    initialSource.status === '',
    `macOS packaging requires a clean source tree, found:\n${initialSource.status}`
  )
  // Keep the release gate coupled to the same source checkout: a package cannot be called
  // "latest" when a design anchor has no production caller or test evidence.
  await run('pnpm', ['--filter', '@agentmux/desktop', 'audit:features'], { cwd: repositoryRoot })
  // The Renderer imports Core's public subpaths (for example `@agentmux/core/agent-status`).
  // Build Core first so a clean checkout never asks Vite to resolve a dist file that has not
  // been emitted yet; the packaged runtime still copies the exact Core output from this build.
  await run('pnpm', ['--filter', '@agentmux/core', 'build'], { cwd: repositoryRoot })
  await run('pnpm', ['--filter', '@agentmux/demand', 'build'], { cwd: repositoryRoot })
  await run('pnpm', ['build'], { cwd: desktopRoot })
  const electronRoot = dirname(require.resolve('electron/package.json'))
  const electronApp = join(electronRoot, 'dist', 'Electron.app')
  assert(await pathExists(electronApp), 'The locked Electron application is missing.')
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentmux-macos-package-'))
  try {
    const candidateRoot = join(temporaryRoot, 'candidate')
    const stagedApp = join(candidateRoot, `${PRODUCT_NAME}.app`)
    const stagedDmg = join(candidateRoot, `${PRODUCT_NAME}-${manifest.version}-${process.platform}-${process.arch}.dmg`)
    await mkdir(candidateRoot, { recursive: true })
    await run('cp', ['-cR', electronApp, stagedApp], { capture: true })
    // Normalize downloaded bundle metadata on the disposable candidate before signing.
    await run('xattr', ['-cr', stagedApp], { capture: true })
    await brandApplication(stagedApp)
    await copyRuntimeApplication(stagedApp, initialSource)
    await verifyIdentity(stagedApp)
    await verifyThirdPartyNotices(stagedApp)
    await auditBundleSymlinks(stagedApp)
    await auditRuntimeReferences(stagedApp, temporaryRoot)
    await run('codesign', ['--force', '--deep', '--sign', '-', stagedApp], { capture: true })
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp], { capture: true })

    await createDmg(stagedApp, stagedDmg, temporaryRoot)
    await verifyDmg(stagedDmg, temporaryRoot, initialSource)
    const finalSource = await sourceIdentity()
    assert(
      finalSource.commit === initialSource.commit &&
        finalSource.tree === initialSource.tree &&
        finalSource.status === initialSource.status,
      `Source tree changed during macOS packaging: ${JSON.stringify({ initialSource, finalSource })}`
    )
    await rm(releaseRoot, { recursive: true, force: true })
    await mkdir(releaseRoot, { recursive: true })
    await rename(stagedApp, outputApp)
    await rename(stagedDmg, outputDmg)
    if (installRequested) await installApplication(outputApp)
    await run(process.execPath, [join(desktopRoot, 'scripts', 'report-desktop-package.mjs')])
    const [appHash, dmgHash, appSizeResult, dmgInfo] = await Promise.all([
      sha256(join(outputApp, 'Contents', 'MacOS', PRODUCT_NAME)),
      sha256(outputDmg),
      run('du', ['-sk', outputApp], { capture: true }),
      stat(outputDmg)
    ])
    const appSize = appSizeResult.stdout.trim().split(/\s+/)[0]
    process.stdout.write([
      `app=${outputApp}`,
      `dmg=${outputDmg}`,
      'signature=adhoc-local-candidate',
      `source_commit=${initialSource.commit}`,
      `source_tree=${initialSource.tree}`,
      'source_status=clean',
      `app_executable_sha256=${appHash}`,
      `dmg_sha256=${dmgHash}`,
      `app_size_kib=${appSize}`,
      `dmg_size_bytes=${dmgInfo.size}`,
      'notarized=false'
    ].join('\n') + '\n')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
