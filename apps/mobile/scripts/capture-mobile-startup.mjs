import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess } from '../../desktop/scripts/probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const buildPath = resolve(root, process.argv[2] ?? '.tmp/mobile-loading-review/build.json')
const evidence = resolve(root, process.argv[3] ?? '.tmp/mobile-loading-review/startup-capture-' + randomUUID())
const fixture = resolve(import.meta.dirname, 'fixtures/mobile-startup')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, visualReview: 'pending-independent-review',
  boundary: 'Standard Vite dist main and original Root/MobileApp served by the installed Host asset owner. One private Electron process; only the exact product chunk and public metadata HTTP leaf are controlled. No authenticated Host, device registration, business input, user browser or two-process recovery claim.' }
await mkdir(evidence, { recursive: true })
let temporaryRoot, processResult, invokedChild = false
try {
  const buildBytes = await readFile(buildPath), build = JSON.parse(buildBytes)
  assert.equal(build.passed, true, 'A completed standard package build is required')
  assert.ok(build.appDynamicChunk && build.entry && build.staticChunks?.length > 0)
  assert.ok(!build.staticChunks.includes(build.appDynamicChunk), 'Product is outside the initial static closure')
  assert.ok(build.graph[build.appDynamicChunk].modules.includes('apps/mobile/src/MobileApp.tsx'))
  assert.ok(build.graph[build.entry].isEntry)
  const initialCSS = [...new Set(build.staticChunks.flatMap(file => {
    assert.ok(Array.isArray(build.graph[file].css), 'Actual static chunk CSS graph is required')
    return build.graph[file].css
  }))]
  assert.ok(Array.isArray(build.graph[build.appDynamicChunk].css), 'Actual product chunk CSS graph is required')
  const productCSS = build.graph[build.appDynamicChunk].css.filter(file => !initialCSS.includes(file))
  assert.ok(productCSS.length > 0, 'The held product stylesheet must be distinct from initial CSS')
  const dist = resolve(root, 'apps/mobile/dist'), releaseBytes = await readFile(join(dist, 'mobile-release.json')), release = JSON.parse(releaseBytes)
  assert.equal(release.digest, build.release.digest); assert.equal(release.buildId, build.release.buildId)
  const source = { ...build.source }
  for (const file of ['apps/mobile/scripts/capture-mobile-startup.mjs', 'apps/mobile/scripts/fixtures/mobile-startup/main.cjs',
    'apps/mobile/scripts/fixtures/mobile-startup/scenario.md', 'apps/desktop/scripts/probe-process.mjs',
    'apps/host/dist/mobile-assets-owner.js', 'apps/host/dist/mobile-assets.js']) source[file] = sha(await readFile(resolve(root, file)))
  for (const [file, digest] of Object.entries(source)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Actual candidate source: ' + file)
  const assets = {}
  for (const item of release.files) {
    const bytes = await readFile(join(dist, item.path)), digest = sha(bytes)
    assert.equal('sha256:' + digest, item.digest, 'Original immutable dist bytes: ' + item.path)
    assert.equal(bytes.length, item.bytes)
    if (build.emitted[item.path]) assert.equal(digest, build.emitted[item.path].sha256, 'Build observer and served asset agree: ' + item.path)
    assets[item.path] = { bytes: bytes.length, sha256: digest }
  }
  receipt.build = { file: relative(root, buildPath), sha256: sha(buildBytes), releaseSHA256: sha(releaseBytes),
    release: build.release, entry: build.entry, staticChunks: build.staticChunks, appDynamicChunk: build.appDynamicChunk, initialCSS, productCSS }
  receipt.source = source; receipt.assets = assets
  temporaryRoot = await mkdtemp(join(tmpdir(), 'amux-mobile-startup-'))
  // The exact temporary main path also identifies this probe to the existing process owner.
  const main = join(temporaryRoot, 'main.cjs'), config = join(temporaryRoot, 'config.json')
  await writeFile(main, await readFile(join(fixture, 'main.cjs')))
  await writeFile(config, JSON.stringify({ root, dist, evidence, privateRoot: temporaryRoot, appDynamicChunk: build.appDynamicChunk, initialCSS, productCSS, release: build.release }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const electron = require('electron')
  invokedChild = true
  processResult = await runProbeProcess(electron, [main, config], { cwd: root, temporaryRoot, env, timeoutMs: 90000,
    onLine: line => process.stderr.write(line.slice(0, 300) + '\n') })
  receipt.process = processResult
  assert.equal(processResult.timedOut, false, 'The private capture completed without its process deadline firing')
  assert.equal(processResult.interruption, null)
  assert.deepEqual(processResult.signals, [], 'A signalled probe cannot stand for ordinary completion')
  const rendererBytes = await readFile(join(evidence, 'renderer.json')), renderer = JSON.parse(rendererBytes)
  receipt.renderer = renderer; receipt.rendererSHA256 = sha(rendererBytes)
  assert.equal(processResult.exitCode, 0, JSON.stringify(renderer.failure)); assert.equal(processResult.exitSignal, null)
  assert.equal(processResult.exitConfirmed, true); assert.equal(processResult.originalPid, renderer.pid)
  assert.equal(renderer.passed, true); assert.equal(renderer.frames.length, 5)
  receipt.images = Object.fromEntries(await Promise.all(renderer.frames.map(async file => [file, sha(await readFile(join(evidence, file)))])))
  for (const [file, digest] of Object.entries(source)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Source retained through capture: ' + file)
  for (const [file, identity] of Object.entries(assets)) assert.equal(sha(await readFile(join(dist, file))), identity.sha256, 'Served dist retained: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  // Preserve an unconfirmed live namespace for the process owner; never delete it on a guess.
  if (temporaryRoot && (!invokedChild || processResult?.exitConfirmed === true)) {
    await rm(temporaryRoot, { recursive: true, force: true }); receipt.cleanup = { removedPrivateProfile: true }
  } else if (temporaryRoot) receipt.cleanup = { removedPrivateProfile: false, retained: temporaryRoot, reason: 'Private process exit is unconfirmed.' }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, join(evidence, 'receipt.json')), failure: receipt.failure }))
}
