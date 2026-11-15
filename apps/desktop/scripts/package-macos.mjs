import { publishPackageArtifact } from '../../../scripts/package-artifact-publisher.mjs'
import { copyRuntimePayload, inspectRuntimeApplicationPayload } from './runtime-application-payload.mjs'
import { privatePackageSmokeEnvironment, preservePackageSmokeFailure } from './package-smoke-context.mjs'
import { updateRoute } from '../src/shared/update-policy.ts'
import { hashRuntimeArtifact } from './update-identity.mjs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
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
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { observeApplicationProcesses, assertApplicationActivationOwnership, applicationQuitOwnershipDiagnostic } from './package-process-scope.mjs'
import {
  assertPackageIdentity,
  canonicalInstallPath,
  readPackageIdentity
} from './package-identity.mjs'
import { preflightMacosSigning, signAndVerifyMacosApplication } from './macos-signing.mjs'
import { verifyNativeDesktopCopy, verifyNativeDesktopSigning } from './native-desktop-package.mjs'

import { PRODUCT_NAME, BUNDLE_ID, MAP_LOCATION_USAGE, applicationBranding } from './macos-application-brand.mjs'
import { inspectElectronApplication } from './electron-application.mjs'
const desktopRoot = resolve(import.meta.dirname, '..')
// Waiting for a packaged GUI to answer is a hang guard, not a speed requirement. On a loaded machine a
// freshly signed App spent most of a minute before Main wrote its first file, and a relaunched App with a
// large workbench missed a 30-second activation window. Wrong identity, an unrestored workbench or an
// early exit still rejects at once; only a slow healthy GUI gains time.
const GUI_STARTUP_HANG_GUARD_MS = 300_000
const GUI_PROGRESS_INTERVAL_MS = 5_000
const repositoryRoot = resolve(desktopRoot, '../..')
const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
const coreRoot = join(repositoryRoot, 'packages', 'core')
const releaseRoot = join(desktopRoot, 'release', 'mac')
const outputApp = join(releaseRoot, `${PRODUCT_NAME}.app`)
const outputDmg = join(
  releaseRoot,
  `${PRODUCT_NAME}-${manifest.version}-${process.platform}-${process.arch}.dmg`
)
const installRequested = process.argv.includes('--install')
const appOnly = process.argv.includes('--app-only')
const installIntent = process.argv.includes('--ui-only') ? 'ui-only' : 'full'
// Runtime 变了就必须先做 Run/resume review——但 review 做完之后要有一条路能装。缺了这条路，
// 任何 ctxmux 升级都永远装不上：门就不再是"先 review"，而是"不许升级"。
// 这个参数带的是 review 记录的路径，不是一个裸开关；它会被读、被校验非空、被打进安装收据。
const runtimeReviewArgument = process.argv.find((argument) => argument.startsWith('--runtime-reviewed='))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function writeProgress(stage, status, started, details) {
  process.stderr.write(`package_progress=${JSON.stringify({ stage, status, elapsedMs: Math.round(performance.now() - started), ...details })}\n`)
}

async function reportPackageStage(stage, action) {
  const started = performance.now()
  writeProgress(stage, 'started', started)
  try {
    const result = await action()
    writeProgress(stage, 'finished', started)
    return result
  } catch (error) {
    writeProgress(stage, 'failed', started)
    throw error
  }
}

async function reportGuiQualification(stage, action) {
  const started = performance.now()
  let check = 'app-inspect', difference, lastFailure, queryStarted, lastQueryMs
  const report = status => writeProgress(stage, status, started, {
    check: status === 'failed' ? lastFailure?.check ?? check : check,
    lastQueryMs, queryElapsedMs: queryStarted === undefined ? undefined : Math.round(performance.now() - queryStarted),
    lastFailedCheck: lastFailure?.check, changedWorkbenchFields: lastFailure?.difference?.()
  })
  const progress = {
    checking(name, describeDifference) { check = name; difference = describeDifference },
    failedCheck() {
      // Do not copy exception text or workbench data into progress output.
      lastFailure = { check: check === 'app-inspect' ? 'app-inspect-unavailable' : check, difference }
    },
    async inspect(observe) {
      progress.checking('app-inspect')
      queryStarted = performance.now()
      try { return await observe() }
      finally {
        lastQueryMs = Math.round(performance.now() - queryStarted)
        queryStarted = undefined
      }
    }
  }
  report('started')
  const timer = setInterval(() => report('waiting'), GUI_PROGRESS_INTERVAL_MS)
  timer.unref()
  try {
    const result = await action(progress)
    report('finished')
    return result
  } catch (error) {
    report('failed')
    throw error
  } finally {
    clearInterval(timer)
  }
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
  const [revision, status] = await Promise.all([
    run('git', ['log', '-1', '--format=%H%n%T', 'HEAD'], { cwd: repositoryRoot, capture: true }),
    run('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: repositoryRoot, capture: true
    })
  ])
  const [commit, tree] = revision.stdout.trim().split('\n')
  return { commit, tree, status: status.stdout.trimEnd() }
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

export async function brandApplication(appPath) {
  const contents = join(appPath, 'Contents'), resources = join(contents, 'Resources')
  const brand = applicationBranding(manifest.version), plist = join(contents, 'Info.plist')
  await rename(join(contents, 'MacOS', brand.executable.source), join(contents, 'MacOS', brand.executable.target))
  for (const [key, value] of Object.entries(brand.plist)) {
    await plistReplace(plist, key, typeof value === 'string' ? 'string' : 'json', typeof value === 'string' ? value : JSON.stringify(value))
  }
  for (const key of brand.removedPlistKeys) await plistRemove(plist, key)
  for (const helper of brand.helpers) {
    const target = join(contents, 'Frameworks', `${helper.target}.app`)
    await rename(join(contents, 'Frameworks', `${helper.source}.app`), target)
    await rename(join(target, 'Contents', 'MacOS', helper.source), join(target, 'Contents', 'MacOS', helper.target))
    const helperPlist = join(target, 'Contents', 'Info.plist')
    for (const [key, value] of Object.entries(helper.plist)) await plistReplace(helperPlist, key, 'string', value)
  }
  await cp(join(desktopRoot, brand.icon.source), join(resources, brand.icon.target))
  for (const name of brand.removedResources) await rm(join(resources, name), { force: true })
}

export async function copyRuntimeApplication(appPath, source) {
  const appResources = join(appPath, 'Contents', 'Resources', 'app')
  await copyRuntimePayload(await inspectRuntimeApplicationPayload(repositoryRoot), appResources, source)
  const coreRuntime = join(appResources, 'node_modules', '@agentmux', 'core')
  await run(process.execPath, [join(coreRuntime, 'bin', 'install-ctxmux.mjs')])
  process.stdout.write('ctxmux_install_validation=passed\n')
}

export async function auditBundle(root, { runtimeRoot = null, forbidden = [] } = {}) {
  const canonicalRoot = await realpath(root)
  const visit = async (directory, inRuntime) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        assert(!target.startsWith('/'), `Bundle contains an absolute symlink: ${path} -> ${target}`)
        const canonicalTarget = await realpath(path)
        const offset = relative(canonicalRoot, canonicalTarget)
        assert(offset !== '..' && !offset.startsWith(`..${sep}`), `Bundle symlink escapes the application: ${path}`)
      } else if (entry.isDirectory()) {
        await visit(path, inRuntime || path === runtimeRoot)
      } else if (inRuntime && entry.isFile() && (await stat(path)).size <= 2 * 1024 * 1024) {
        const content = await readFile(path)
        if (content.includes(0)) continue
        const text = content.toString('utf8')
        for (const reference of forbidden) {
          assert(!text.includes(reference), `Packaged runtime contains a build-machine path in ${path}.`)
        }
      }
    }
  }
  await visit(root, root === runtimeRoot)
}

async function verifyIdentity(appPath) {
  const contents = join(appPath, 'Contents')
  const plist = join(contents, 'Info.plist')
  assert(await plistValue(plist, 'CFBundleDisplayName') === PRODUCT_NAME, 'Packaged display name is wrong.')
  assert(await plistValue(plist, 'CFBundleExecutable') === PRODUCT_NAME, 'Packaged executable name is wrong.')
  assert(await plistValue(plist, 'CFBundleIdentifier') === BUNDLE_ID, 'Packaged bundle id is wrong.')
  assert(await plistValue(plist, 'CFBundleURLTypes.0.CFBundleURLSchemes.0') === 'amux', 'Packaged spatial link scheme is wrong.')
  assert(await plistValue(plist, 'CFBundleURLTypes.1.CFBundleURLSchemes.0') === 'http' && await plistValue(plist, 'CFBundleURLTypes.1.CFBundleURLSchemes.1') === 'https' && await plistValue(plist, 'CFBundleURLTypes.1.CFBundleTypeRole') === 'Viewer', 'Packaged web link schemes are wrong.')
  for (const [index, type] of ['public.html', 'public.xhtml'].entries()) {
    assert(await plistValue(plist, `CFBundleDocumentTypes.${index}.CFBundleTypeRole`) === 'Viewer' && await plistValue(plist, `CFBundleDocumentTypes.${index}.LSItemContentTypes.0`) === type, 'Packaged local webpage Viewer declarations are wrong.')
  }
  assert(await plistValue(plist, 'CFBundleIconFile') === 'agentmux.icns', 'Packaged icon is wrong.')
  for (const key of ['NSLocationUsageDescription', 'NSLocationWhenInUseUsageDescription']) {
    assert(await plistValue(plist, key) === MAP_LOCATION_USAGE, 'Packaged location usage text is wrong.')
  }
  assert((await plistValue(plist, 'NSScreenCaptureUsageDescription')).length > 0, 'Packaged screen capture purpose is missing.')
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

export async function verifyWorkspaceMoveHelper(path, expectedSha256) {
  const info = await stat(path)
  assert(info.isFile() && (info.mode & 0o111) !== 0,
    'Packaged Workspace move helper is missing or not executable.')
  assert(await sha256(path) === expectedSha256,
    'Packaged Workspace move helper does not match the verified artifact.')
}

async function verifyPackagedRuntime(appPath, verificationRoot, source, signedWorkspaceMoveHelperSha256) {
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
  await verifyWorkspaceMoveHelper(workspaceMoveHelper, signedWorkspaceMoveHelperSha256)
  const [cli, daemon, agentmux] = await Promise.all([
    run(join(binaryRoot, 'ctxmux'), ['--version'], { capture: true }),
    run(join(binaryRoot, 'ctxmuxd'), ['--version'], { capture: true }),
    run(join(coreRuntime, 'bin', 'amux'), ['--version'], {
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
  const coreVersion = JSON.parse(await readFile(join(coreRuntime, 'package.json'), 'utf8')).version
  assert(agentmux.stdout.trim() === `amux ${coreVersion}`, 'Packaged AgentMux CLI cannot use the embedded runtime.')
}

async function scopedProcesses(appPath, previousOwners = [], independentOwners = []) {
  const canonicalAppPath = await realpath(appPath).catch(error => {
    if (error.code === 'ENOENT') return resolve(appPath)
    throw error
  })
  const executable = join(canonicalAppPath, 'Contents', 'MacOS', PRODUCT_NAME)
  const helperRoot = join(canonicalAppPath, 'Contents', 'Frameworks') + sep
  return observeApplicationProcesses({ executable, helperRoot }, previousOwners, { independentOwners })
}

// The bundle's *serving* processes: main + renderer/GPU/utility helpers. A
// detached crash reporter and confirmed external Node clients are excluded.
// Main's own Node workers, unknown modes, and original owner births stay in
// scope; see package-process-scope.mjs for the bound OS facts.
async function processIdsForApplication(appPath, previousOwners = []) {
  return (await scopedProcesses(appPath, previousOwners)).serving
}

export async function waitForProcessExit(findProcessIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = await findProcessIds()
  while (remaining.length > 0) {
    const delay = Math.min(20, deadline - Date.now())
    if (delay <= 0) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
    remaining = await findProcessIds()
  }
  // A slow final snapshot can outlive a short-lived process. Signal zero only
  // checks existence; permission errors and every result other than ESRCH stay protected.
  return remaining.filter(pid => {
    if (!Number.isSafeInteger(pid) || pid < 2) return true
    try { process.kill(pid, 0); return true }
    catch (error) { return error?.code !== 'ESRCH' }
  })
}

async function waitForPath(path, deadline, isAlive) {
  while (true) {
    if (Date.now() > deadline) return false
    const exists = await pathExists(path)
    if (Date.now() > deadline) return false
    if (exists) return true
    if (isAlive && !(await isAlive())) {
      // The application can publish its receipt and exit during the OS query.
      // Consume that final receipt without extending the original deadline.
      const ready = await pathExists(path)
      return ready && Date.now() <= deadline
    }
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

async function cleanupSmokeHost(service) {
  const { macosHostServiceRegistration, inspectMacosHostService, stopMacosHostService } = await import('../../host/dist/macos-service.js')
  const { probeSocketLiveness } = await import('@agentmux/core')
  const registration = await macosHostServiceRegistration(service)
  let owner
  if (registration) {
    owner = await inspectMacosHostService(service)
    await stopMacosHostService(service, owner)
  }
  assert(await macosHostServiceRegistration(service) === null, 'Launch smoke private Host service remains registered.')
  assert(await probeSocketLiveness(service.socketPath) === 'dead', 'Launch smoke private Host endpoint exit is unconfirmed.')
  return { schema: 'agentmux.private-package-host-cleanup.v1', label: service.label, target: service.target,
    socketPath: service.socketPath, storePath: service.storePath, owner: owner ?? null, status: 'unregistered' }
}

async function verifyLaunchServices(appPath, verificationRoot) {
  const { createPrivateRuntimeScope } = await import('./package-runtime-upgrade.mjs')
  const { macosHostService, macosHostServiceRegistration } = await import('../../host/dist/macos-service.js')
  const { defaultAgentMuxControlSocketPath } = await import('@agentmux/core')
  const canonicalAppPath = await realpath(appPath)
  const readyFile = join(verificationRoot, 'desktop-ready.json')
  const userData = join(verificationRoot, 'user-data')
  const stdoutPath = join(verificationRoot, 'desktop-stdout.log')
  const stderrPath = join(verificationRoot, 'desktop-stderr.log')
  const privateRuntime = await createPrivateRuntimeScope(join(canonicalAppPath, 'Contents', 'Resources', 'app', 'node_modules', '@agentmux', 'core'))
  const runtimeRoot = privateRuntime.directory
  const endpointPath = privateRuntime.socketPath
  const executable = join(canonicalAppPath, 'Contents', 'MacOS', PRODUCT_NAME)
  const daemonEntrypoint = privateRuntime.daemonPath
  await mkdir(userData, { recursive: true })
  const before = new Set(await processIdsForApplication(canonicalAppPath))
  const ownedApplicationPids = async () => (
    (await processIdsForApplication(canonicalAppPath)).filter((pid) => !before.has(pid))
  )
  const guiEnvironment = privatePackageSmokeEnvironment(process.env, { userData, runtimeRoot, readyFile })
  const service = macosHostService({ executable, entrypoint: join(canonicalAppPath, 'Contents/Resources/app/out/main/agentmux-host.js'),
    storePath: guiEnvironment.AGENTMUX_AGENT_SESSION_STORE, socketPath: defaultAgentMuxControlSocketPath(guiEnvironment),
    mobileBuildDirectory: join(canonicalAppPath, 'Contents/Resources/app/out/mobile'), environment: guiEnvironment })
  assert(await macosHostServiceRegistration(service) === null, 'Private launch smoke Host service already exists.')
  let verificationError
  let verificationStage = 'launch-request'
  // One absolute deadline shared by launch, ready, Runtime ownership and exit.
  const verificationDeadline = Date.now() + GUI_STARTUP_HANG_GUARD_MS
  try {
    for (const name of ['HOME', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
      await mkdir(guiEnvironment[name], { recursive: true, mode: 0o700 })
    }
    await run('open', ['-n', '--stdout', stdoutPath, '--stderr', stderrPath,
      ...Object.entries(guiEnvironment).flatMap(([name, value]) => ['--env', `${name}=${value}`]), canonicalAppPath
    ], { capture: false, timeoutMs: Math.max(1, verificationDeadline - Date.now()), env: guiEnvironment })
    verificationStage = 'ready-receipt'
    let sawProcess = false
    const isAppAlive = async () => {
      const pids = await ownedApplicationPids()
      if (pids.length > 0) sawProcess = true
      return !sawProcess || pids.length > 0
    }
    assert(await waitForPath(readyFile, verificationDeadline, isAppAlive), 'Packaged Desktop did not emit its ready receipt.')
    const ready = JSON.parse(await readFile(readyFile, 'utf8'))
    assert(ready.productName === PRODUCT_NAME && ready.version === manifest.version,
      'LaunchServices started an application with the wrong product identity.')
    assert(ready.packaged === true, 'LaunchServices did not start the packaged application.')
    assert(await realpath(ready.executable) === executable,
      'LaunchServices ready receipt did not come from the exact relocated application.')
    verificationStage = 'runtime-owner-receipt'
    const ownerReceiptPath = await privateRuntime.ownerReceiptPath()
    assert(await waitForPath(ownerReceiptPath, verificationDeadline, isAppAlive), 'Packaged CtxMux did not publish its ownership receipt.')
    const ownerReceipt = JSON.parse(await readFile(ownerReceiptPath, 'utf8'))
    assert(await realpath(ownerReceipt.daemonPath) === await realpath(daemonEntrypoint) &&
      ownerReceipt.socketPath === endpointPath,
      'LaunchServices did not start the exact packaged CtxMux runtime.')
    await privateRuntime.observeOwner()
    verificationStage = 'application-exit'
    const remainingApplicationPids = await waitForProcessExit(ownedApplicationPids,
      Math.max(1, verificationDeadline - Date.now()))
    assert(Date.now() <= verificationDeadline && remainingApplicationPids.length === 0,
      `Packaged Desktop did not exit normally: ${remainingApplicationPids.join(', ')}`)
  } catch (error) {
    verificationError = new Error(`Packaged Desktop ${verificationStage} failed: ${error.message}`,
      { cause: error })
  }
  const cleanupErrors = await cleanupProcessScope('application', ownedApplicationPids)
  let hostStopped = false
  try {
    const receipt = await cleanupSmokeHost(service)
    hostStopped = true
    await writeFile(join(verificationRoot, 'semantic-host-cleanup.json'), JSON.stringify(receipt, null, 2) + '\n')
  } catch (error) { cleanupErrors.push(error) }
  if (hostStopped) {
    try {
      const receipt = await privateRuntime.cleanup()
      await writeFile(join(verificationRoot, 'runtime-cleanup.json'), JSON.stringify(receipt, null, 2) + '\n')
      if (receipt.signals.includes('SIGKILL')) cleanupErrors.push(new Error('Launch smoke Runtime required forced termination.'))
    } catch (error) { cleanupErrors.push(error) }
  }
  if (cleanupErrors.length === 0) {
    try {
      await rm(runtimeRoot, { recursive: true, force: true })
      assert(!await pathExists(endpointPath), 'Launch smoke endpoint survived cleanup.')
    } catch (error) { cleanupErrors.push(error) }
  }
  const failures = [verificationError, ...cleanupErrors].filter(Boolean)
  if (failures.length > 0) {
    const failure = new AggregateError(failures,
      `Packaged Desktop verification failed; Runtime diagnostics retained if cleanup failed: ${runtimeRoot}`)
    if (cleanupErrors.length > 0) failure.privateSmokeCleanup = { status: 'unconfirmed', runtimeRoot, hostStopped }
    throw failure
  }
  process.stdout.write('packaged_desktop_launch=passed\n')
}

async function createDmg(appPath, dmgPath, temporaryRoot) {
  const dmgRoot = join(temporaryRoot, 'dmg-root')
  await mkdir(dmgRoot)
  // `cp -cR` falls back to a very slow cross-volume copy on macOS when the staging root is under
  // the short system temporary root. `ditto` is the same resource-preserving primitive used for installation and keeps
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
  await rm(dmgRoot, { recursive: true, force: true })
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

async function verifyDmg(dmgPath, temporaryRoot, source, signedWorkspaceMoveHelperSha256, signingPlan) {
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
  await auditBundle(installedApp)
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp], { capture: true })
  await verifyPackagedRuntime(installedApp, verificationRoot, source, signedWorkspaceMoveHelperSha256)
  if (signingPlan?.kind === 'ad-hoc') {
    process.stderr.write('Ad-hoc development candidate: skipping LaunchServices smoke test on temporary volume.\n')
  } else {
    await verifyLaunchServices(installedApp, verificationRoot)
  }
}

/**
 * 让已装路径上正在跑的实例退出，并回报它是否存在过。
 *
 * 先 `osascript … quit` 走 Cmd+Q 那条路：桌面端在退出时 flush 布局状态（见 registerUnloadFlush），
 * 直接 SIGKILL 会丢掉用户当前的 Tab/Region 布局。请求退出后等 GUI 进程真的消失；超时停止安装，
 * 不升级到信号。确证的 semantic Host 随后交给自己的 namespace shutdown，不冒充 GUI。
 *
 * `osascript` 失败**不是**错误：app 没在跑、没注册到 LaunchServices、AppleScript 被策略拦，都会让它
 * 非零退出，而这些情况下"让它退出"这个目标本来就已经达成或无从达成。判据是**进程还在不在**，不是
 * 那条命令的退出码。
 *
 * 只对**服务着这份包**的进程（主进程 + renderer/GPU/utility helper）设判据。脱钩的 crash-reporter
 * helper（app 退出后被 launchd 收养，PPID 1，不 flush 任何状态、也无法服务 UI）会被跳过——但会打印
 * 出来，因为一个残留的它曾经让每一次后续安装都卡住（prior observation 实测 pid 1033）。跳过而不是杀掉：安装
 * 路径不发信号是这里的既定承诺（见 package-install-restart.test.ts），交给 OS 回收更安全。
 */
async function quitInstalledApplication(appPath, originalOwners = [], semanticHost = null) {
  const { inspectSemanticHostForInstall } = await import('./package-semantic-host.mjs')
  if (semanticHost) assert(semanticHost.currentApp === appPath, 'The prepared Semantic Host belongs to another application; its processes are retained.')
  const semanticOwner = semanticHost ? (await inspectSemanticHostForInstall(semanticHost)).row : null
  // Independent execution ownership ends GUI ancestry, including branches
  // through Native. Semantic shutdown retains its separate narrow Node scope.
  const independentOwners = semanticOwner ? [semanticOwner] : []
  const scope = await scopedProcesses(appPath, originalOwners, independentOwners)
  const running = scope.serving, { crashReporter } = scope
  let previousOwners = scope.admissions, lastScope = scope
  if (crashReporter.length > 0) {
    process.stdout.write(`ignored_detached_crash_reporter=${crashReporter.join(',')} (orphaned Electron crash handler; serves no bundle, left for the OS to reap)\n`)
  }
  if (running.length === 0) return { wasRunning: false, pids: [], admissions: previousOwners }
  const bundleId = await plistValue(join(appPath, 'Contents/Info.plist'), 'CFBundleIdentifier')
  assert(/^[a-zA-Z0-9.-]+$/.test(bundleId), 'Application bundle identity is invalid; no quit was requested.')
  await run('osascript', ['-e', `quit app id "${bundleId}"`], { capture: true, timeoutMs: 15_000 })
    .catch(() => undefined)
  const remaining = await waitForProcessExit(async () => {
    const current = await scopedProcesses(appPath, previousOwners, independentOwners)
    lastScope = current
    previousOwners = current.admissions
    return current.serving
  }, 20_000)
  if (remaining.length > 0) throw Object.assign(new Error(
    `Application has not exited gracefully (pids ${remaining.join(', ')}). Installation stopped; no processes were force-killed. Finish or save current work before retrying.`),
  { ownershipDiagnostic: applicationQuitOwnershipDiagnostic({ ...lastScope, serving: remaining }, originalOwners) })
  return { wasRunning: true, pids: running, admissions: previousOwners }
}

/**
 * 装完必须交付**一个跑着新包的进程**，不是只换掉磁盘上的目录。
 *
 * 为什么这一步是承重的：安装用 `rename` 原子换目录，旧的整份被 `mv` 进 `~/.Trash`。已运行的进程按
 * **inode** 持有它打开的文件，目录改名不影响那些 inode——于是旧实例会从垃圾桶里**静默继续跑**，
 * 零报错零提示。此时磁盘上每一项身份校验（package-identity、bundle 内容）都通过，而用户面前那个
 * 窗口跑的仍是旧代码。prior observation 实测：主进程 prior clock 启动、安装 prior clock，用户按新包的预期去点链接，
 * 看到的是三小时前那份的行为，三层磁盘验证一条都没能发现。
 *
 * 所以这里在 rename 之后重新拉起。这里返回的是启动瞬间的观察，不是随后出现的 helper 的完整名单；
 * 激活后的归属由实际 loaded Main、OS 出生事实和父子关系确认，并独立排除原 owner 仍存活的情况。
 */
async function relaunchInstalledApplication(appPath) {
  const guiEnvironment = { ...process.env }
  delete guiEnvironment.ELECTRON_RUN_AS_NODE
  await run('open', ['-a', appPath], { capture: false, timeoutMs: 60_000, env: guiEnvironment })
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

// Tab/Region arrays are registries. Layout arrays retain their presentation order.
function runningRegionsWithoutRun(workbench) {
  return workbench.tabs.flatMap(tab => tab.regions.filter(region =>
    (region.kind === 'agent' || region.kind === 'terminal') && region.processState === 'running' && !region.control)
    .map(region => region.regionId))
}

function workbenchIdentity(workbench, { expectedAfterRestart = false, includeSurvey = true, includeSurveyPageReferences = true } = {}) {
  const survey = workbench.survey && { ...workbench.survey }
  if (survey && !includeSurveyPageReferences) delete survey.pageReferences
  return { activeWorkspaceId: workbench.activeWorkspaceId, mainSurface: workbench.mainSurface, focus: workbench.focus,
    ...(includeSurvey ? { survey } : {}),
    layouts: workbench.layouts, tabs: workbench.tabs.map(tab => ({ ...tab, regions: tab.regions.map(region => {
      if (region.kind === 'terminal') {
        // A raw shell's legacy sessionId is its execution Run, not a durable AgentSession.
        // Any changed binding is independently qualified against exact Native facts below.
        const { sessionId, control, processState, ...descriptor } = region
        return descriptor
      }
      if (region.kind === 'agent') {
        const { control, processState, ...descriptor } = region
        return descriptor
      }
      if (region.kind === 'browser') {
        const { loading, error, navigationId, nativeOwner, title, ...descriptor } = region
        // Private pages retain their placement, but their URL must not survive restart.
        return expectedAfterRestart && descriptor.mode === 'private' ? { ...descriptor, url: 'about:blank' } : descriptor
      }
      return region
    }).sort((a, b) => a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0) }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }
}

/** Actual loaded identity and complete Store topology, not process appearance. */
async function qualifyUi(appPath, before, { outgoing = false, progress }) {
  const { observeUiClient, requireOutgoingWorkbenchStorage } = await import('./package-runtime-upgrade.mjs')
  const observation = await progress.inspect(() => observeUiClient(appPath))
  try {
    progress.checking('main-package-identity')
    assert(observation.main.package, 'The loaded Main package identity is unknown; no UI commit can be confirmed.')
    assertPackageIdentity(observation.main.package, await readPackageIdentity(appPath))
    progress.checking('workbench-loading')
    assert(!observation.workbench.loading, 'The saved workbench is still loading; no UI commit can be confirmed.')
    if (outgoing) {
      progress.checking('outgoing-workbench-storage')
      requireOutgoingWorkbenchStorage(observation)
    }
    progress.checking('renderer-identity')
    const bundled = JSON.parse(await readFile(join(appPath, 'Contents/Resources/app/out/renderer/release.json'), 'utf8'))
    assert(observation.main.renderer.identity.shell === bundled.identity.shell && observation.main.renderer.identity.ctxmux === bundled.identity.ctxmux,
      'The loaded Renderer does not belong to this application contract.')
    if (before) {
      // Missing older facts do not gain empty values or revoke the activated GUI. The final receipt stays unknown.
      const includeSurvey = before.workbench.survey !== undefined && observation.workbench.survey !== undefined
      const includeSurveyPageReferences = before.workbench.survey?.pageReferences !== undefined && observation.workbench.survey?.pageReferences !== undefined
      const actual = workbenchIdentity(observation.workbench, { includeSurvey, includeSurveyPageReferences })
      const expected = workbenchIdentity(before.workbench, { expectedAfterRestart: true, includeSurvey, includeSurveyPageReferences })
      let changedFields
      progress.checking('workbench-continuity', () => changedFields ??= Object.keys(expected).filter(key => !isDeepStrictEqual(actual[key], expected[key])))
      assert(isDeepStrictEqual(actual, expected),
        'The original workbench, Region descriptors or focus have not been restored.')
      progress.checking('original-run-binding')
      for (const tab of before.workbench.tabs) for (const region of tab.regions) {
        const restored = observation.workbench.tabs.find(candidate => candidate.id === tab.id)?.regions.find(candidate => candidate.regionId === region.regionId)
        // A Region that had no confirmed Run before the update has no identity to compare; it is
        // reported as unconfirmed in the receipt rather than turning a restored workbench into a failure.
        if ((region.kind === 'agent' || region.kind === 'terminal') && region.processState === 'running' && region.control) {
          assert(restored && restored.kind === region.kind && restored.control && region.control &&
            restored.control.run.runId === region.control.run.runId && restored.control.hostId === region.control.hostId,
          'An original healthy Run is not yet available in its restored Region.')
        }
        // Browser descriptors and placement are protected by equality above.
        // Navigation remains a page-local observation in this same receipt; restoring
        // the original workbench does not require waking hidden pages or network access.
      }
    }
    return observation
  } catch (error) {
    error.uiContinuity = { before: structuredClone(before), after: structuredClone(observation) }
    throw error
  }
}

// The outgoing read is one public read-only RPC. A loaded original Main can miss its own short Control
// budget; that is an unknown observation, not an unhealthy GUI. Retry only the missing read within the
// GUI hang guard. A qualification failure on an actual observation (loading, storage, identity) still rejects.
async function qualifyOutgoingUi(appPath) {
  const deadline = Date.now() + GUI_STARTUP_HANG_GUARD_MS
  return reportGuiQualification('outgoing-gui', async progress => {
    while (true) {
      try { return await qualifyUi(appPath, null, { outgoing: true, progress }) }
      catch (error) {
        progress.failedCheck()
        if (error.uiContinuity || Date.now() >= deadline) throw error
      }
      progress.checking('retry-delay')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  })
}

async function awaitUiActivation(appPath, before, runtimePlan = null) {
  const { confirmUiRuntime, assertUiRuntimeObservation, confirmUiTerminalRebindings } = await import('./package-runtime-upgrade.mjs')
  const deadline = Date.now() + GUI_STARTUP_HANG_GUARD_MS
  return reportGuiQualification('installed-gui', async progress => {
    let lastError, lastObservation = null
    do {
      try {
        const observed = await qualifyUi(appPath, before, { progress })
        lastObservation = observed
        progress.checking('runtime-continuity')
        const confirmation = runtimePlan ? await confirmUiRuntime(runtimePlan) : null
        if (confirmation) assertUiRuntimeObservation(observed, confirmation, before)
        progress.checking('terminal-rebindings')
        const terminalRebindings = await confirmUiTerminalRebindings(runtimePlan, confirmation, before, observed)
        return { observation: observed, terminalRebindings }
      }
      catch (error) {
        lastError = error
        progress.failedCheck()
        if (error.uiContinuity?.after) lastObservation = error.uiContinuity.after
      }
      progress.checking('retry-delay')
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    // Preserve the last successful read even if a later RPC observation fails.
    throw Object.assign(lastError, { uiContinuity: { before: structuredClone(before), after: structuredClone(lastObservation) } })
  })
}

// Cleanup evidence uses the same package and signed seals as stage adoption.
// Failure to observe it never adds an installation qualification gate.
async function signedSourceIdentity(appPath) {
  const root = await lstat(appPath)
  assert(root.isDirectory() && !root.isSymbolicLink(), 'The signed source directory is unavailable.')
  return { dev: root.dev, ino: root.ino, package: await readPackageIdentity(appPath),
    executable: await sha256(join(appPath, 'Contents', 'MacOS', PRODUCT_NAME)),
    seal: await sha256(join(appPath, 'Contents', '_CodeSignature', 'CodeResources')) }
}

export async function installApplication(appPath, { intent = installIntent, homeDirectory = homedir(),
  quit = quitInstalledApplication, launch = relaunchInstalledApplication, preparedApplicationPath = null } = {}) {
  const { closeRuntimeUpgrade, finishRuntimeUpgrade, prepareRuntimeUpgrade, prepareUiRuntime, confirmUiRuntime } = await import('./package-runtime-upgrade.mjs')
  const { prepareSemanticHostReload, stopSemanticHostForInstall, confirmSemanticHostReload } = await import('./package-semantic-host.mjs')
  assert(intent === 'full' || intent === 'ui-only', 'Unknown installation intent.')
  const currentPath = canonicalInstallPath(homeDirectory)
  let runtimeReviewPath
  let runtimeChanged = false
  if (await pathExists(currentPath)) {
    const runtimeRelative = 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux'
    const [currentRuntime, candidateRuntime] = await Promise.all([
      hashRuntimeArtifact(currentPath, runtimeRelative), hashRuntimeArtifact(appPath, runtimeRelative)
    ])
    if (updateRoute({ shell: '', ctxmux: currentRuntime }, { shell: '', ctxmux: candidateRuntime }) === 'runtime-review') {
      runtimeChanged = true
      // Review records the release boundary. Actual same-Runtime planned-exec
      // confirmation below is required before the new GUI can start.
      assert(intent === 'ui-only' || runtimeReviewArgument,
        'CtxMux runtime differs; record its same-Runtime planned-exec review and pass --runtime-reviewed=<path>. No running application was changed.')
      if (intent === 'full') {
        runtimeReviewPath = runtimeReviewArgument.slice('--runtime-reviewed='.length)
        assert(runtimeReviewPath, '--runtime-reviewed= needs the path to the Run/resume review, not an empty value.')
        const review = await readFile(runtimeReviewPath, 'utf8').catch(() => null)
        assert(review !== null, `Cannot read the Run/resume review at ${runtimeReviewPath}; nothing proves the review happened.`)
        assert(review.trim().length > 0, `The Run/resume review at ${runtimeReviewPath} is empty.`)
      }
    }
  }

  const destination = canonicalInstallPath(homeDirectory)
  const previouslyInstalled = await pathExists(destination)
  const applicationsRoot = dirname(destination)
  const trashRoot = join(homeDirectory, '.Trash')
  assert(preparedApplicationPath === null || typeof preparedApplicationPath === 'string' && preparedApplicationPath.length > 0,
    'A prepared installer stage must name its retained directory; the application was not changed.')
  const next = preparedApplicationPath === null ? join(applicationsRoot, `.${PRODUCT_NAME}.install-${process.pid}-${randomUUID()}.app`) : resolve(preparedApplicationPath)
  let ownedStage = null, sourceBefore = null, cutoverStarted = false
  try {
    await mkdir(applicationsRoot, { recursive: true })
    if (preparedApplicationPath === null) {
      sourceBefore = await signedSourceIdentity(appPath).catch(() => null)
      // Exclusive creation never reclaims a stage belonging to another attempt.
      await mkdir(next)
      ownedStage = { identity: await lstat(next).catch(() => null) }
      const sameVolume = (await stat(appPath)).dev === (await stat(applicationsRoot)).dev
      await run(sameVolume ? 'cp' : 'ditto', sameVolume ? ['-cRp', `${appPath}/.`, next] : [appPath, next], { capture: true })
    } else {
      // Explicit adoption requalifies the retained object; it never copies or removes it.
      const prefix = `.${PRODUCT_NAME}.install-`, stageName = basename(next)
      assert(dirname(next) === resolve(applicationsRoot) && stageName.startsWith(prefix) && /^[1-9]\d*(?:-[a-f0-9-]{36})?\.app$/.test(stageName.slice(prefix.length)),
        'A prepared installer stage must be an original install directory beside the canonical application; the application was not changed.')
      const stage = await lstat(next)
      assert(stage.isDirectory() && !stage.isSymbolicLink() && stage.uid === process.getuid(),
        'A prepared installer stage must be a real directory owned by this user; the application was not changed.')
      if (previouslyInstalled) {
        const installed = await stat(destination)
        assert(installed.dev !== stage.dev || installed.ino !== stage.ino,
          'A prepared installer stage must be a different real directory from the canonical application; the application was not changed.')
      }
      assert(await realpath(next) === join(await realpath(applicationsRoot), stageName),
        'A prepared installer stage must remain inside the canonical Applications directory; the application was not changed.')
      assertPackageIdentity(await readPackageIdentity(next), await readPackageIdentity(appPath))
      for (const artifact of [['Contents', 'MacOS', PRODUCT_NAME], ['Contents', '_CodeSignature', 'CodeResources']]) {
        const [selectedHash, stageHash] = await Promise.all([sha256(join(appPath, ...artifact)), sha256(join(next, ...artifact))])
        assert(/^[a-f0-9]{64}$/.test(selectedHash) && stageHash === selectedHash,
          `Prepared installer stage ${artifact.at(-1)} does not match the selected signed application; the application was not changed.`)
      }
    }
    await run('codesign', ['--verify', '--deep', '--strict', next], { capture: true })
    let runtimeUpgrade = null, uiRuntime = null, before = null, semanticHost = null
    let native = { status: 'unchanged' }
    let previousScope = await scopedProcesses(currentPath)
    let running = previousScope.serving
    try {
      if (previouslyInstalled) {
        semanticHost = await prepareSemanticHostReload(currentPath, next)
        // Admit original GUI owners only after independent namespace facts are
        // available. A preliminary observation is not permanent ownership.
        previousScope = await scopedProcesses(currentPath, [], semanticHost ? [semanticHost.owner] : [])
        running = previousScope.serving
      }
      if (running.length > 0) before = await qualifyOutgoingUi(currentPath)
      if (intent === 'ui-only' || before && !runtimeChanged) uiRuntime = await prepareUiRuntime(previouslyInstalled ? currentPath : null, next, before)
      if (intent === 'full' && runtimeChanged) runtimeUpgrade = await prepareRuntimeUpgrade(currentPath, next)
      if (intent === 'ui-only') native = { status: 'deferred', reason: uiRuntime
        ? 'Explicit UI-only transaction; the existing Runtime is retained without a Native upgrade.'
        : 'No existing listener was observed. No Native upgrade was attempted; ordinary GUI startup may start a Runtime.' }
    } catch (error) {
      await closeRuntimeUpgrade(uiRuntime)
      throw Object.assign(error, { transaction: { intent, ui: { status: 'not-started', error: error.message,
        ...(error.uiContinuity ? { continuity: error.uiContinuity } : {}) }, native } })
    }
    try {
      // 换目录之前先请旧实例退出。放在 ditto/codesign 之后，是为了让候选包先被证明可用——候选不合格时
      // 不该白关掉用户正在用的窗口。
      const quitOutcome = previouslyInstalled && running.length > 0
        ? await quit(destination, previousScope.admissions, semanticHost)
        : { wasRunning: false, pids: [], admissions: previousScope.admissions }
      try {
        if (!semanticHost && previouslyInstalled) {
          semanticHost = await prepareSemanticHostReload(currentPath, next)
        }
        await stopSemanticHostForInstall(semanticHost)
        if (uiRuntime) await confirmUiRuntime(uiRuntime)
      } catch (error) {
        if (quitOutcome.wasRunning) {
          await launch(destination)
          await awaitUiActivation(destination, before, uiRuntime)
        }
        throw Object.assign(error, { transaction: { intent, ui: { status: quitOutcome.wasRunning ? 'restored' : 'not-started', error: error.message }, native } })
      }
      // A pending action in the old GUI could have started a Runtime after the
      // first absent-listener observation. Recheck that same owner after GUI exit.
      if (intent === 'full' && runtimeChanged && !runtimeUpgrade) {
        try { runtimeUpgrade = await prepareRuntimeUpgrade(destination, next) }
        catch (error) {
          if (quitOutcome.wasRunning) {
            await launch(destination)
            await awaitUiActivation(destination, before, uiRuntime)
            error.transaction = { intent, ui: { status: 'restored', error: error.message }, native }
          }
          throw error
        }
      }
      if (running.length === 0 && (await processIdsForApplication(destination)).length > 0) {
        throw Object.assign(new Error('A GUI appeared during cold preflight; the original application directory was not changed.'),
          { transaction: { intent, ui: { status: 'not-started' }, native } })
      }
      let previousInstall
      // From this point the candidate may become active or be retained by rollback.
      cutoverStarted = true
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
          if (uiRuntime) await confirmUiRuntime(uiRuntime)
          if (quitOutcome.wasRunning) {
            await launch(destination)
            await awaitUiActivation(destination, before, uiRuntime)
            error.transaction = { intent, ui: { status: 'restored', error: error.message }, native }
          }
        }
        throw error
      }
      if (runtimeUpgrade) {
        const handoff = await finishRuntimeUpgrade(runtimeUpgrade, destination)
        process.stdout.write(`runtime_handoff=${JSON.stringify(handoff)}\n`)
        native = { status: handoff.status === 'upgraded' ? 'committed' : handoff.status === 'old-confirmed' ? 'unchanged' : 'unknown', handoff }
        if (handoff.status === 'old-confirmed') {
          // The original protocol and exact owner/Run facts are positively confirmed.
          // Keep the candidate in next; restore the old client for that live service.
          assert(previousInstall, 'The original application is unavailable for the confirmed old Runtime.')
          await rename(destination, next)
          await rename(previousInstall, destination)
          await launch(destination)
          await awaitUiActivation(destination, before, { ...runtimeUpgrade, newSdk: runtimeUpgrade.oldSdk })
          throw Object.assign(new Error(`Runtime upgrade failed; the original application and healthy Runtime are restored: ${handoff.error}`),
            { transaction: { intent, ui: { status: 'restored', error: handoff.error }, native } })
        }
        assert(handoff.status === 'upgraded',
          `Runtime handoff is unknown; candidate and previous application are retained. No new GUI was started: ${handoff.error}`)
        if (handoff.ownerReceiptError) process.stderr.write(`Runtime upgraded; ownership receipt could not be saved: ${handoff.ownerReceiptError}\n`)
      }
      process.stdout.write(`installed_app=${destination}\n`)
      if (runtimeReviewPath) process.stdout.write(`runtime_review=${runtimeReviewPath}\n`)
      if (previousInstall) process.stdout.write(`previous_install_trashed=${previousInstall}\n`)
      process.stdout.write(`quit_previous_instance=${quitOutcome.wasRunning ? quitOutcome.pids.join(',') : 'not_running'}\n`)
      let relaunched, observed, terminalRebindings
      const launchBaseline = await scopedProcesses(destination)
      try {
        relaunched = await launch(destination)
        const activation = await awaitUiActivation(destination, before, uiRuntime ?? runtimeUpgrade)
        observed = activation.observation; terminalRebindings = activation.terminalRebindings
        await confirmSemanticHostReload(semanticHost, destination)
      } catch (error) {
        const result = { intent, ui: { status: 'unknown', error: error.message }, native, candidate: destination, previous: previousInstall ?? null }
        // An unobserved GUI cannot be force-quit or treated as safely rolled back.
        if (before && native.status !== 'committed' && previousInstall && (await processIdsForApplication(destination)).length === 0) {
          await rename(destination, next)
          if (uiRuntime) await confirmUiRuntime(uiRuntime)
          await rename(previousInstall, destination)
          await launch(destination)
          await awaitUiActivation(destination, before, uiRuntime)
          result.ui = { status: 'restored', error: error.message }
        }
        throw Object.assign(error, { transaction: result })
      }
      process.stdout.write(`relaunched_pids=${relaunched.join(',')}\n`)
      const activatedScope = await scopedProcesses(destination)
      const activatedOwners = confirmApplicationActivation({
        previous: quitOutcome.admissions,
        beforeLaunch: launchBaseline.processes, scope: activatedScope,
        main: observed.main, intent, native, path: destination
      })
      process.stdout.write(`activated_serving_owners=${JSON.stringify(activatedOwners)}\n`)
      if (!before && (previouslyInstalled || intent === 'ui-only')) return { intent, ui: { status: 'unknown', path: destination, observation: observed, terminalRebindings,
        reason: 'The candidate GUI is active. Without an outgoing workbench observation, complete recovery cannot be confirmed.' }, native }
      const unconfirmed = []
      if (observed.workbench.survey === undefined || before && before.workbench.survey === undefined)
        unconfirmed.push('Complete Survey continuity is unconfirmed because an original or restored stored preference observation is unavailable.')
      else if (observed.workbench.survey.pageReferences === undefined || before && before.workbench.survey.pageReferences === undefined)
        unconfirmed.push('Survey Page reference continuity is unconfirmed because an original or restored stored Page reference observation is unavailable.')
      const unboundRegions = before ? runningRegionsWithoutRun(before.workbench) : []
      if (unboundRegions.length > 0)
        unconfirmed.push(`Run continuity is unconfirmed for Regions that had no confirmed Run before the update: ${unboundRegions.join(', ')}.`)
      if (unconfirmed.length > 0) return { intent, ui: {
        status: 'unknown', path: destination, observation: observed, terminalRebindings,
        reason: `The candidate GUI is active. ${unconfirmed.join(' ')}`,
        continuity: { before: structuredClone(before), after: structuredClone(observed) } }, native }
      return { intent, ui: { status: 'committed', main: observed.main, path: destination, observation: observed,
        terminalRebindings }, native }
    } catch (error) {
      if (!error.transaction) error.transaction = { intent, ui: { status: 'unknown', error: error.message }, native }
      if (error.ownershipDiagnostic) error.transaction.ui.ownership = error.ownershipDiagnostic
      if (error.uiContinuity) error.transaction.ui.continuity = error.uiContinuity
      throw error
    } finally {
      await closeRuntimeUpgrade(runtimeUpgrade)
      await closeRuntimeUpgrade(uiRuntime)
    }
  } catch (error) {
    if (ownedStage) {
      let cleanup
      try {
        const stage = await lstat(next).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause })
        if (!stage) cleanup = { status: 'consumed', path: next }
        else if (cutoverStarted) cleanup = { status: 'retained', path: next, reason: 'Directory cutover began; preserve the continuation candidate.' }
        else {
          assert(sourceBefore && isDeepStrictEqual(sourceBefore, await signedSourceIdentity(appPath)),
            'The original signed source is not confirmed unchanged; preserve this candidate.')
          const current = await lstat(next)
          assert(ownedStage.identity && current.isDirectory() && !current.isSymbolicLink() && current.dev === ownedStage.identity.dev && current.ino === ownedStage.identity.ino,
            'The installer stage changed identity; preserve the unconfirmed object.')
          await rm(next, { recursive: true })
          cleanup = { status: 'removed', path: next }
        }
      } catch (cause) { cleanup = { status: 'retained', path: next, reason: cause.message } }
      // Maintenance never replaces the original installation error or transaction.
      error.installStage = cleanup
      if (error.transaction) error.transaction.installStage = cleanup
      process.stderr.write(`install_stage_cleanup=${JSON.stringify(cleanup)}\n`)
    }
    throw error
  }
}

/** Preserve already-qualified UI facts when the final process ownership is unknown. */
export function confirmApplicationActivation({ previous, beforeLaunch, scope, main, intent, native, path }) {
  try {
    return assertApplicationActivationOwnership({ previous, beforeLaunch,
      current: scope.processes, serving: scope.serving, mainPid: main.pid,
      observation: scope.ownershipObservation })
  } catch (error) {
    error.transaction = { intent, ui: { status: 'unknown', path, error: error.message,
      completedStages: ['candidate-launch', 'ui-activation'], failedStage: 'application-process-ownership',
      main, ownership: error.ownershipDiagnostic }, native }
    throw error
  }
}

/** UI and Native outcomes are separate, including partial or unknown failure. */
export function reportInstallTransaction(result) {
  assert(result && result.ui && result.native, 'Installation did not return both component outcomes.')
  process.stdout.write(`install_transaction=${JSON.stringify(result)}\n`)
  if (result.native.status === 'deferred') process.stdout.write(`Native update deferred: ${result.native.reason} The existing Runtime and Runs were not replaced.\n`)
}

async function main({ selectAfterBuild, install = installRequested, onlyApp = appOnly } = {}) {
  assert(!process.argv.includes('--ui-only') || install, '--ui-only requires --install.')
  const qualifySigning = () => {
    assert(process.platform === 'darwin', 'macOS packaging must run on macOS.')
    assert(process.arch === 'arm64', `AgentMux currently packages only darwin-arm64, not darwin-${process.arch}.`)
    const argv = process.argv.slice(2)
    if (install && !argv.includes('--install')) argv.push('--install')
    return preflightMacosSigning({ argv })
  }
  const build = () => reportPackageStage('build', () => run('pnpm', ['--config.enable-pre-post-scripts=true', 'build'], { cwd: desktopRoot }))
  let signingPlan, initialSource
  if (selectAfterBuild) {
    // Only an App consumes Git provenance; its snapshot must precede the routing build.
    const [source] = await Promise.allSettled([sourceIdentity()])
    await build()
    if (await selectAfterBuild() === 'renderer') return
    if (source.status === 'rejected') throw source.reason
    initialSource = source.value
  } else {
    signingPlan = await qualifySigning()
    initialSource = await sourceIdentity()
  }
  assert(initialSource.status === '', `macOS packaging requires a clean source tree, found:\n${initialSource.status}`)
  signingPlan ??= await qualifySigning()
  if (!selectAfterBuild) await build()
  if (signingPlan.kind === 'ad-hoc') process.stderr.write('Development ad hoc candidate: permission continuity across updates is unconfirmed. The existing App and Runs remain unchanged during packaging.\n')
  const { application: electronApp } = await inspectElectronApplication(repositoryRoot)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentmux-macos-package-'))
  let retainedDiagnostics = false
  let packagingError
  try {
    const candidateRoot = join(temporaryRoot, 'candidate')
    const stagedApp = join(candidateRoot, `${PRODUCT_NAME}.app`)
    const stagedDmg = join(candidateRoot, `${PRODUCT_NAME}-${manifest.version}-${process.platform}-${process.arch}.dmg`)
    const stagedWorkspaceMoveHelper = join(stagedApp, 'Contents', 'Resources', 'app', 'resources', 'bin', 'agentmux-workspace-move')
    await reportPackageStage('app-assembly', async () => {
      await mkdir(candidateRoot, { recursive: true })
      await run('cp', ['-cR', electronApp, stagedApp], { capture: true })
      // Normalize downloaded bundle metadata on the disposable candidate before signing.
      await run('xattr', ['-cr', stagedApp], { capture: true })
      await brandApplication(stagedApp)
      await copyRuntimeApplication(stagedApp, initialSource)
      await verifyIdentity(stagedApp)
      await verifyThirdPartyNotices(stagedApp)
      await auditBundle(stagedApp, {
        runtimeRoot: join(stagedApp, 'Contents', 'Resources', 'app'),
        forbidden: [repositoryRoot, temporaryRoot]
      })
      await verifyWorkspaceMoveHelper(stagedWorkspaceMoveHelper,
        await sha256(join(desktopRoot, 'resources', 'bin', 'agentmux-workspace-move')))
      const locationAddOn = 'agentmux-mac-location.node'
      assert(await sha256(join(dirname(stagedWorkspaceMoveHelper), locationAddOn)) ===
        await sha256(join(desktopRoot, 'resources', 'bin', locationAddOn)), 'Packaged location add-on differs from the built candidate.')
      await verifyNativeDesktopCopy(stagedApp, repositoryRoot)
    })
    process.stdout.write('Signing and verifying macOS candidate...\n')
    const signature = await reportPackageStage('signing', async () => {
      const signed = await signAndVerifyMacosApplication(stagedApp, signingPlan)
      await verifyNativeDesktopSigning(stagedApp, signingPlan)
      return signed
    })
    const signedWorkspaceMoveHelperSha256 = await sha256(stagedWorkspaceMoveHelper)

    if (onlyApp) {
      await reportPackageStage('app-verification', async () => {
        await verifyPackagedRuntime(stagedApp, temporaryRoot, initialSource, signedWorkspaceMoveHelperSha256)
        if (signingPlan.kind !== 'ad-hoc') await verifyLaunchServices(stagedApp, temporaryRoot)
      })
    } else {
      await reportPackageStage('dmg-creation', () => createDmg(stagedApp, stagedDmg, temporaryRoot))
      await reportPackageStage('dmg-verification', () => verifyDmg(stagedDmg, temporaryRoot, initialSource, signedWorkspaceMoveHelperSha256, signingPlan))
    }
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
    if (!onlyApp) await rename(stagedDmg, outputDmg)
    const qualifiedDmgHash = onlyApp ? null : await sha256(outputDmg)
    if (!onlyApp) {
      const artifacts = await reportPackageStage('dmg-publication', () =>
        publishPackageArtifact({ repositoryRoot, target: 'darwin-arm64', archive: outputDmg, sha256: qualifiedDmgHash }))
      process.stdout.write(`package_artifact_publication=${JSON.stringify(artifacts.publication)}\n`)
      process.stdout.write(`package_artifact_cleanup=${JSON.stringify(artifacts.cleanup)}\n`)
    }
    if (install) reportInstallTransaction(await reportPackageStage('installation', () => installApplication(outputApp)))
    if (!onlyApp) await run(process.execPath, [join(desktopRoot, 'scripts', 'report-desktop-package.mjs')])
    const [appHash, dmgHash, appSizeResult, dmgInfo] = await Promise.all([
      sha256(join(outputApp, 'Contents', 'MacOS', PRODUCT_NAME)),
      qualifiedDmgHash,
      run('du', ['-sk', outputApp], { capture: true }),
      onlyApp ? null : stat(outputDmg)
    ])
    const appSize = appSizeResult.stdout.trim().split(/\s+/)[0]
    process.stdout.write([
      `app=${outputApp}`,
      `dmg=${onlyApp ? 'not-requested' : outputDmg}`,
      `signature=${signature.kind === 'certificate' ? 'certificate-local-candidate' : 'adhoc-development-candidate'}`,
      `signature_team=${signature.teamId ?? 'none'}`,
      'authorization_continuity=unverified',
      `source_commit=${initialSource.commit}`,
      `source_tree=${initialSource.tree}`,
      'source_status=clean',
      `app_executable_sha256=${appHash}`,
      `dmg_sha256=${dmgHash ?? 'not-requested'}`,
      `app_size_kib=${appSize}`,
      `dmg_size_bytes=${dmgInfo?.size ?? 'not-requested'}`,
      'notarized=false'
    ].join('\n') + '\n')
  } catch (error) {
    packagingError = error
    retainedDiagnostics = error.privateSmokeCleanup?.status === 'unconfirmed'
    try {
      const receipt = await preservePackageSmokeFailure(temporaryRoot, join(repositoryRoot, '.local', 'state', 'package-failures'), error)
      process.stderr.write(`package_failure_diagnostics=${receipt.directory}\n`)
      if (retainedDiagnostics) process.stderr.write(`package_failure_staging=${temporaryRoot}\n`)
    } catch (diagnosticError) {
      retainedDiagnostics = true
      const preservedError = new AggregateError([error, diagnosticError], `Package diagnostics could not be preserved; original staging retained: ${temporaryRoot}`, { cause: error })
      if (error.transaction) preservedError.transaction = error.transaction
      throw preservedError
    }
    throw error
  } finally {
    if (!retainedDiagnostics) {
      try { await rm(temporaryRoot, { recursive: true, force: true }) }
      catch (cleanupError) {
        if (!packagingError) throw cleanupError
        const failure = new AggregateError([packagingError, cleanupError], 'Package staging cleanup failed; the original failure is retained.', { cause: packagingError })
        if (packagingError.transaction) failure.transaction = packagingError.transaction
        throw failure
      }
    }
  }
}

export { main as packageMacos }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) {
    if (error.transaction) reportInstallTransaction(error.transaction)
    throw error
  }
}
