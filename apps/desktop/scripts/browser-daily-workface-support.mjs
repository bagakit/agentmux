import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, resolve, join, sep, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { assertSourceBrowserConsumers } from './lib/browser-capability-cost-collector.mjs'

const exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export async function retainDailyEvidence(receipt, file, kind) {
  const bytes = await readFile(file)
  const evidence = { file, sha256: sha(bytes), byteLength: bytes.length, kind }
  const existing = receipt.dailyEvidence?.find(item => item.file === file && item.sha256 === evidence.sha256)
  if (existing) return existing
  ;(receipt.dailyEvidence ??= []).push(evidence)
  return evidence
}

export async function retainDailyNativeObserverEvidence(receipt, captureDirectory) {
  for (const directory of await readdir(captureDirectory, { withFileTypes: true })) {
    if (!directory.isDirectory() || !directory.name.startsWith('native-review-')) continue
    for (const file of await readdir(join(captureDirectory, directory.name), { withFileTypes: true })) {
      if (file.isFile() && /\.(json|png)$/.test(file.name)) await retainDailyEvidence(receipt,
        join(captureDirectory, directory.name, file.name), 'native-observer-original-output')
    }
  }
}

export async function retainedPrivateTaskDataReference(repositoryRoot) {
  const common = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repositoryRoot })).stdout.trim()
  const index = JSON.parse(await readFile(join(dirname(common), '.local/browser-daily-p0p1/t003-native/index.json'), 'utf8'))
  const bytes = await readFile(index.receipt.path)
  assert.equal(sha(bytes), index.receipt.sha256)
  const original = JSON.parse(bytes), facts = original.taskData.privateCounterexamples
  assert.equal(original.case, 'task-data-outcomes'); assert.equal(original.passed, true)
  assert.equal(facts.safe.status, 'completed'); assert.equal(facts.blockedFacts.completion.status, 'unavailable')
  assert.equal(facts.partialFacts.completion.status, 'not-met'); assert.equal(facts.retention.release.status, 'retained')
  assert.deepEqual(original.taskData.coldRead.nativeBefore, []); assert.deepEqual(original.taskData.coldRead.nativeAfter, [])
  return { ...index.receipt, sourceCommit: original.sourceCommit,
    scope: 'Historical T003 private task behavior. Current T005 geometry and its CSS counterexample run in the current App.' }
}

/** Two original mounted Source tests; no mutation matrix and no Native owner. */
export async function prepareDailySourceConsumers({ repositoryRoot, captureDirectory, receipt }) {
  const file = join(captureDirectory, 'source-consumers.json'), log = join(captureDirectory, 'source-consumers.log')
  const require = createRequire(join(repositoryRoot, 'package.json'))
  const candidate = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_)/.test(key)))
  Object.assign(env, { AGENTMUX_SOURCE_CANDIDATE_COMMIT: candidate, AGENTMUX_BROWSER_SOURCE_CONSUMER_REPORT: file })
  try {
    const result = await exec(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', 'apps/desktop/test/browser-store-consumer-costs.test.tsx',
      '-t', '^measures (actual selector observer|the actual existing Workspace)', '--pool=threads', '--maxWorkers=1', '--no-file-parallelism'],
    { cwd: repositoryRoot, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    await writeFile(log, result.stdout + result.stderr)
  } catch (error) {
    await writeFile(log, String(error.stdout ?? '') + String(error.stderr ?? '') + '\n' + error.message)
    await retainDailyEvidence(receipt, log, 'source-consumer-log')
    throw error
  }
  const report = JSON.parse(await readFile(file, 'utf8'))
  assertSourceBrowserConsumers(report)
  for (const item of report.reports) assert.equal(item.candidateCommit, candidate)
  await retainDailyEvidence(receipt, file, 'source-consumer-report')
  await retainDailyEvidence(receipt, log, 'source-consumer-log')
  return async () => structuredClone(report)
}

/** Diagnostic observations of only this invocation's owned storage/processes. */
export async function recordDailyOwnedResources(receipt, { stage, root, captureDirectory, pids = [] }) {
  const paths = [root, join(root, 'app-data'), join(root, 'user-data'), join(root, 'home'), join(root, 'runtime'),
    join(root, 'runtime/state'), join(root, 'runtime/state/ctxmux/hooks/hook-runtime'), join(root, 'runtime/state/ctxmux/hooks/hook-runtime/interpreters'), captureDirectory]
  const commands = [['du', ['/usr/bin/du', ['-k', '-d', '2', root, captureDirectory]]],
    ['hookRuntime', ['/usr/bin/du', ['-sk', join(root, 'runtime/state/ctxmux/hooks/hook-runtime'), join(root, 'runtime/state/ctxmux'), join(root, 'app-data')]]],
    ['df', ['/bin/df', ['-k', captureDirectory]]], ['swap', ['/usr/sbin/sysctl', ['-n', 'vm.swapusage']]],
    ['ownProcesses', ['/bin/ps', ['-p', [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 1))].join(','), '-o', 'pid=,ppid=,rss=,vsz=,comm=']]]]
  const results = await Promise.all(commands.map(async ([name, [command, args]]) => {
    try { const value = await exec(command, args, { timeout: 5_000, maxBuffer: 512 * 1024 }); return [name, { stdout: value.stdout, stderr: value.stderr }] }
    catch (error) { return [name, { code: error.code ?? null, message: error.message, stdout: error.stdout, stderr: error.stderr }] }
  }))
  const entries = await Promise.all(paths.map(async path => { try { const s = await stat(path); return { path, size: s.size, blocks: s.blocks, allocatedBytes: s.blocks * 512 } } catch (error) { return { path, code: error.code ?? null } } }))
  const observation = { stage, at: new Date().toISOString(), paths: entries, ...Object.fromEntries(results),
    boundary: 'Owned paths and PIDs only. du/stat allocations, shared clone blocks, volume df and system swap are observations, not a unique physical-allocation or causal claim.' }
  ;(receipt.ownedResourceObservations ??= []).push(observation)
  try { await new Promise((done, fail) => process.stdout.write(JSON.stringify({ ownedResourceObservation: observation }) + '\n', error => error ? fail(error) : done())) }
  catch (error) { observation.stdoutError = { code: error.code ?? null, message: error.message } }
  return observation
}

const foregroundMetadata = 'ObjC.import("AppKit"); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({pid:Number(a.processIdentifier),bundleId:ObjC.unwrap(a.bundleIdentifier),activationPolicy:Number(a.activationPolicy),launchedAt:Number(a.launchDate.timeIntervalSince1970),terminated:Boolean(a.terminated)})'
/** App-level metadata only: no SystemEvents, AX, authentication or input. */
export async function readDailyForegroundApplication() {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', foregroundMetadata], { timeout: 5_000, maxBuffer: 32_768 })
  return { ...JSON.parse(stdout), raw: stdout }
}
export async function restoreDailyForegroundApplication(original, privatePids) {
  // The observed authentication/system foreground is never an activation target.
  if (original?.activationPolicy !== 0 || original?.bundleId === 'com.apple.loginwindow')
    return { outcome: 'original-not-an-ordinary-work-app', original, current: await readDailyForegroundApplication(), action: 'none' }
  const program = 'ObjC.import("AppKit"); function describe(a){return{pid:Number(a.processIdentifier),bundleId:ObjC.unwrap(a.bundleIdentifier),activationPolicy:Number(a.activationPolicy),launchedAt:Number(a.launchDate.timeIntervalSince1970),terminated:Boolean(a.terminated)}} function run(argv){var original=JSON.parse(argv[0]),pids=JSON.parse(argv[1]),current=describe($.NSWorkspace.sharedWorkspace.frontmostApplication);if(pids.indexOf(current.pid)<0)return JSON.stringify({outcome:"later-frontmost-kept",original:original,before:current,action:"none"});var target=$.NSRunningApplication.runningApplicationWithProcessIdentifier(original.pid),actual=describe(target);if(actual.pid!==original.pid||actual.bundleId!==original.bundleId||actual.terminated||actual.activationPolicy!==0||(original.launchedAt>0&&actual.launchedAt!==original.launchedAt))return JSON.stringify({outcome:"original-app-unconfirmed",original:original,before:current,observed:actual,action:"none"});var accepted=Boolean(target.activateWithOptions($.NSApplicationActivateIgnoringOtherApps));return JSON.stringify({outcome:"app-activation-requested",original:original,before:current,accepted:accepted,after:describe($.NSWorkspace.sharedWorkspace.frontmostApplication),scope:"App only; no exact window or caret restoration claim"})}'
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', program, JSON.stringify(original), JSON.stringify(privatePids)], { timeout: 5_000, maxBuffer: 32_768 })
  return { ...JSON.parse(stdout), raw: stdout }
}

/** Restore only this actual private window before a real UI input consumer. */
export async function restoreDailyPrivateWindowForInput(ctx, label) {
  const pid = ctx.probe.child.pid, directory = ctx.receipt.visual.captureDirectory
  const call = async (phase, args) => {
    let stdout
    try { ({ stdout } = await exec('/usr/local/bin/orca', args, { timeout: 8_000, maxBuffer: 8 * 1024 * 1024 })); return JSON.parse(stdout) }
    catch (error) {
      const file = join(directory, label + '-orca-' + phase + '-failed.json')
      await writeFile(file, JSON.stringify({ executable: '/usr/local/bin/orca', args, code: error.code ?? null,
        message: error.message, stdout: stdout ?? error.stdout, stderr: error.stderr }, null, 2) + '\n')
      await retainDailyEvidence(ctx.receipt, file, 'original-private-ui-failed-call')
      throw error
    }
  }
  const listed = await call('windows', ['computer', 'list-windows', '--app', 'pid:' + pid, '--json'])
  const listedFile = join(directory, label + '-orca-windows.json')
  await writeFile(listedFile, JSON.stringify(listed, null, 2) + '\n'); await retainDailyEvidence(ctx.receipt, listedFile, 'original-private-ui-window')
  assert.equal(listed.ok, true); assert.equal(listed.result.windows.length, 1)
  const window = listed.result.windows[0]; assert.equal(window.app.pid, pid)
  const selector = window.id !== 'none' && window.id !== null && window.id !== undefined ? ['--window-id', String(window.id)] : ['--window-index', String(window.index)]
  const restored = await call('restore', ['computer', 'get-app-state', '--app', 'pid:' + pid, ...selector, '--restore-window', '--json'])
  const stateFile = join(directory, label + '-orca-restored.json')
  await writeFile(stateFile, JSON.stringify(restored, null, 2) + '\n'); await retainDailyEvidence(ctx.receipt, stateFile, 'original-private-ui-restore')
  assert.equal(restored.ok, true); assert.equal(restored.result.snapshot.app.pid, pid)
  const original = resolve(restored.result.screenshot.path), image = join(directory, label + '-orca-restored.png')
  await copyFile(original, image); assert.equal(sha(await readFile(original)), sha(await readFile(image)))
  await retainDailyEvidence(ctx.receipt, image, 'original-private-ui-restore-image')
  const removed = dirname(original) === join(tmpdir(), 'orca-computer-use') && basename(original) === restored.id + '-screenshot.png'
  const fileStat = await stat(original)
  let outputDf
  try { outputDf = (await exec('/bin/df', ['-k', original], { timeout: 5_000, maxBuffer: 32_768 })).stdout } catch (error) { outputDf = { code: error.code ?? null } }
  if (removed) await rm(original)
  return { pid, window: { selector: selector[0], value: selector[1] }, stateFile, image, originalScreenshot: { file: original, size: fileStat.size, blocks: fileStat.blocks, allocatedBytes: fileStat.blocks * 512, dfBeforeRemoval: outputDf, removed },
    boundary: 'Original fixed Orca restore only; no production active override, button approval or input was sent.' }
}

/** An outside UI audit is never approval: only the unchanged Main NSAlert can approve. */
export function createDailyNativeReviewPort({ receipt, captureDirectory }) {
  return async ({ probe, pid, kind, profileId, review }) => {
    assert.equal(pid, probe.child.pid)
    const directory = join(captureDirectory, 'native-review-' + review.reviewId)
    await mkdir(directory)
    const requestFile = join(directory, 'request.json'), observationFile = join(directory, 'ui-observation.json')
    const request = { schema: 'agentmux.private-native-review-request.v1', pid, kind, profileId, reviewId: review.reviewId,
      extensionId: review.extensionId, name: review.name, version: review.version, expectedRevision: review.expectedRevision, sha256: review.sha256,
      permissions: review.permissions, source: review.source, observationFile,
      boundary: 'Optional UI observer preparation only. An audit never approves Main. The unchanged NSAlert is the sole approver; preserve the original apply and inspect it after unknown.' }
    await writeFile(requestFile, JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await retainDailyEvidence(receipt, requestFile, 'native-review-request')
    process.stdout.write(JSON.stringify({ nativeReviewObserverRequested: true, pid, kind, profileId, reviewId: review.reviewId, requestFile, observationFile }) + '\n')
    const observer = spawn(process.execPath, [import.meta.filename, '--observe-native-review', requestFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    const observerRecord = { pid: observer.pid ?? null, requestFile, executable: '/usr/local/bin/orca', exitCode: null, exitSignal: null }
    ;(receipt.dailyNativeObservers ??= []).push(observerRecord)
    observer.stdout.on('data', bytes => process.stdout.write(bytes)); observer.stderr.on('data', bytes => process.stderr.write(bytes))
    observer.once('error', error => { observerRecord.spawnError = { code: error.code ?? null, message: error.message } })
    observer.once('close', (code, signal) => { observerRecord.exitCode = code; observerRecord.exitSignal = signal })
    return async owner => {
      let ownerResult, ownerFailure
      void owner.then(result => { ownerResult = result }, error => { ownerFailure = error })
      const issues = []
      while (true) {
        let observation
        try {
          observation = JSON.parse(await readFile(observationFile, 'utf8'))
          assert.equal(observation.schema, 'agentmux.private-native-review-observation.v1')
          assert.equal(observation.pid, pid); assert.equal(observation.profileId, profileId); assert.equal(observation.reviewId, review.reviewId)
          assert.ok(observation.window?.selector && observation.window.value !== undefined)
          assert.ok(['orca', 'human-original-ui'].includes(observation.action?.source)); assert.ok(observation.action.record)
          for (const item of observation.evidence ?? []) {
            const file = resolve(item.file); assert.ok(file.startsWith(resolve(directory) + sep))
            assert.equal(sha(await readFile(file)), item.sha256); await retainDailyEvidence(receipt, file, item.kind ?? 'native-ui-evidence')
          }
          await retainDailyEvidence(receipt, observationFile, 'native-ui-observation')
          return { ...observation, state: 'observed', actor: observation.action.source, observer: observerRecord }
        } catch (error) {
          if (error.code !== 'ENOENT' && !issues.length) issues.push({ name: error.name, code: error.code ?? null, message: error.message })
        }
        if (ownerFailure) throw ownerFailure
        if (ownerResult?.state === 'applied') {
          if (observer.exitCode === null && observer.signalCode === null) { observerRecord.stopReason = 'original-main-owner-confirmed'; observer.kill('SIGTERM') }
          return { state: 'unconfirmed', actor: 'unknown', pid, profileId, reviewId: review.reviewId, observer: observerRecord, issues,
            boundary: 'The exact Main owner and original native load were confirmed. UI action attribution is unknown and cannot revoke that result or authorize another action.' }
        }
        await delay(100)
      }
    }
  }
}

/**
 * One bounded read-only Orca watcher. It never clicks, grants approval or calls
 * product APIs. The Agent sees its actual new modal image, then uses fresh AX
 * state for one real action and records that original provider receipt.
 */
export async function observeDailyNativeReview(requestFile) {
  const requestBytes = await readFile(requestFile), request = JSON.parse(requestBytes), directory = dirname(resolve(requestFile))
  assert.equal(request.schema, 'agentmux.private-native-review-request.v1')
  assert.ok(Number.isSafeInteger(request.pid) && request.pid > 1)
  assert.equal(request.observationFile, join(directory, 'ui-observation.json'))
  const executable = '/usr/local/bin/orca', app = 'pid:' + request.pid, evidence = [], originalScreenshots = []
  const stopped = new AbortController()
  process.once('SIGTERM', () => stopped.abort())
  const save = async (name, value, screenshot = false) => {
    const file = join(directory, name + '.json')
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    evidence.push({ file, sha256: sha(await readFile(file)) })
    let image
    if (screenshot) {
      assert.ok(value.result?.screenshot?.path, 'The original Orca screenshot is unavailable')
      image = join(directory, name + '.png')
      await copyFile(value.result.screenshot.path, image)
      const imageSha = sha(await readFile(image))
      assert.equal(imageSha, sha(await readFile(value.result.screenshot.path)))
      evidence.push({ file: image, sha256: imageSha })
      const original = resolve(value.result.screenshot.path)
      const owned = dirname(original) === join(tmpdir(), 'orca-computer-use') && basename(original) === value.id + '-screenshot.png'
      const fileStat = await stat(original)
      let outputDf
      try { outputDf = (await exec('/bin/df', ['-k', original], { timeout: 5_000, maxBuffer: 32_768 })).stdout } catch (error) { outputDf = { code: error.code ?? null } }
      if (owned) await rm(original)
      originalScreenshots.push({ original, retained: image, sha256: imageSha, size: fileStat.size, blocks: fileStat.blocks, allocatedBytes: fileStat.blocks * 512, dfBeforeRemoval: outputDf, removed: owned,
        ...(owned ? {} : { reason: 'The original provider output path is outside this exact known screenshot namespace; retained without deletion.' }) })
    }
    return { file, image }
  }
  const call = async args => {
    let stdout
    try { ({ stdout } = await exec(executable, args.concat('--json'), { timeout: 8_000, maxBuffer: 8 * 1024 * 1024, signal: stopped.signal })) }
    catch (error) {
      await save('orca-failed-call-' + Date.now(), { executable, args, code: error.code, message: error.message,
        stdout: error.stdout, stderr: error.stderr })
      throw error
    }
    const result = JSON.parse(stdout)
    if (!result.ok) {
      await save('orca-unavailable-' + Date.now(), result)
      throw new Error('Original Orca observation is unavailable; no UI action or permission was supplied: ' + JSON.stringify(result.error))
    }
    return result
  }
  const selector = window => window.id !== 'none' && window.id !== null && window.id !== undefined
    ? ['--window-id', String(window.id)] : ['--window-index', String(window.index)]
  const deadline = Date.now() + 175_000
  while (Date.now() < deadline) {
    const current = await call(['computer', 'list-windows', '--app', app])
    assert.ok(current.result.windows.every(window => window.app.pid === request.pid))
    for (const window of current.result.windows) {
      const state = await call(['computer', 'get-app-state', '--app', app, ...selector(window), '--no-screenshot'])
      assert.equal(state.result.snapshot.app.pid, request.pid)
      // This text only raises a read-only observation for the Agent. It grants
      // no control fact and never selects or dispatches an approval action.
      if (!state.result.snapshot.treeText.includes(request.name)) continue
      const visible = await call(['computer', 'get-app-state', '--app', app, ...selector(window)])
      assert.equal(visible.result.snapshot.app.pid, request.pid)
      const saved = await save('orca-original-review-visible', visible, true)
      await save('orca-original-review-windows', current)
      await save('orca-observer-output-cleanup', { observerPid: process.pid, originalScreenshots })
      process.stdout.write(JSON.stringify({ nativeReviewObservationReady: true, pid: request.pid, profileId: request.profileId,
        reviewId: request.reviewId, window: { selector: selector(window)[0], value: selector(window)[1] },
        stateFile: saved.file, screenshotFile: saved.image, evidence, actionPerformed: false }) + '\n')
      return
    }
    await delay(150)
  }
  throw new Error('The original native review UI was not observed within this bounded request. No action or approval was supplied.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], '--observe-native-review')
  assert.equal(process.argv.length, 4)
  await observeDailyNativeReview(resolve(process.argv[3]))
}
