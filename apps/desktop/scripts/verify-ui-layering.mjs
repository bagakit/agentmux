import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
import { assertWorkspaceDistBuiltFromCurrentSource } from '../../../vitest.dist-freshness.ts'

const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json')), { build } = await import('vite')
const clientRequire = createRequire(join(repository, 'packages/client-ui/package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild'), dialog = createRequire(clientRequire.resolve('@radix-ui/react-dialog'))
const aliases = Object.fromEntries(['@radix-ui/react-dismissable-layer', '@radix-ui/react-focus-scope'].map(name => [name, dialog.resolve(name)]))
const fixture = join(desktop, 'scripts/fixtures/ui-layering')
const mobileOnly = process.argv.includes('--mobile-only')
const fullscreenOnly = process.argv.includes('--fullscreen-only')
const withoutSystemFullscreen = process.argv.includes('--without-system-fullscreen')
assert.ok(!mobileOnly || !fullscreenOnly, 'Choose one scoped development check')
assert.ok(!withoutSystemFullscreen || !(mobileOnly || fullscreenOnly), '--without-system-fullscreen runs the complete remaining matrix, not a scoped development check')
assert.ok(!(mobileOnly || fullscreenOnly) || !process.argv.includes('--mutations'), 'A scoped development check is not the complete mutation proof')
const outputIndex = process.argv.indexOf('--output')
assert.ok(outputIndex < 0 || process.argv[outputIndex + 1], '--output requires a directory')
const root = outputIndex < 0 ? join(repository, '.tmp/ui-layering', randomUUID()) : resolve(process.argv[outputIndex + 1])
await mkdir(root, { recursive: true })
assert.equal((await readdir(root)).length, 0, '--output must select a fresh directory; existing evidence is preserved')
const hash = value => createHash('sha256').update(value).digest('hex')
function candidateIdentity() {
  const git = args => execFileSync('git', args, { cwd: repository })
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']).toString().trim()
  const trackedStatus = git(['status', '--porcelain=v1', '--untracked-files=no']).toString().trim()
  return { head: git(['rev-parse', 'HEAD']).toString().trim(), clean: status === '', trackedClean: trackedStatus === '', status, trackedStatus,
    trackedDiffSHA256: hash(Buffer.concat([git(['diff', '--binary', 'HEAD']), git(['diff', '--cached', '--binary'])])) }
}
const candidate = { started: candidateIdentity(), finished: null, unchanged: false }
const originalInputs = new Map(), dependencyInputs = new Map(), results = []
const harnessInputs = {}
for (const path of ['apps/desktop/scripts/verify-ui-layering.mjs', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/radix-overlay-aliases.ts',
  'apps/desktop/scripts/lib/fixture-values.mjs', 'vitest.dist-freshness.ts', 'pnpm-lock.yaml']) {
  const digest = hash(await readFile(join(repository, path))); originalInputs.set(path, digest); harnessInputs[path] = digest
}
const dependencyLockSHA256 = harnessInputs['pnpm-lock.yaml']
const partial = mobileOnly || fullscreenOnly || withoutSystemFullscreen
const evidence = { schema: 'agentmux.ui-layering.v1', passed: false, availableChecksPassed: false, completeGate: false,
  uncovered: [...(withoutSystemFullscreen ? ['native-system-fullscreen'] : []), ...(!process.env.AGENTMUX_VISUAL_ORCA_CLI ? ['OS-composition'] : [])],
  scope: mobileOnly ? 'mobile-only' : fullscreenOnly ? 'system-fullscreen-only' : withoutSystemFullscreen ? 'partial-without-system-fullscreen' : 'complete', captureOnly: false, aestheticReview: 'independent-review-pending', userRunTouched: false,
  boundary: 'Isolated actual Workbench→Store→ConfirmationDialog→Modal→window host→collector→Hook→IPC→NativeOverlaySurfaces→native input→original DOM handler. Preview Agent facts and explicit native Browser test page; no real CLI stop, installed App, durable restart or physical OS keyboard claim.', candidate, harnessInputs, results }
const mutations = [
  { label: 'non-atomic-required-pair', path: 'apps/desktop/src/main/native-overlay-surfaces.ts',
    before: 'await boundedChromePaint(this.paint(projection, Boolean(modalId)))', after: 'await boundedChromePaint(this.paint(projection, false))', expected: /Required modal pair has no orphan scrim/ },
  { label: 'background-input-during-preparation', path: 'apps/desktop/src/main/native-overlay-surfaces.ts',
    before: 'if (this.modalBlocks(view, owner.browserId)) event.preventDefault()', after: 'if (false) event.preventDefault()', expected: /Modal preparation blocks only its original background Browser input/ },
  { label: 'nested-overlay-escapes-modal', path: 'packages/client-ui/src/components/Modal.tsx',
    before: 'return attachment ? attachment.ready ? attachment.container : null : fallback', after: 'return fallback', expected: /A portaled tooltip stays above its parent modal/ }
]
function transformSource(source, path, mutation, changes) {
  const digest = hash(source)
  if (originalInputs.has(path)) assert.equal(digest, originalInputs.get(path), 'Every proof run consumes the same candidate input: ' + path)
  else originalInputs.set(path, digest)
  if (mutation?.path !== path) return source
  assert.equal(source.split(mutation.before).length - 1, 1, 'Private mutation must match a unique nonempty actual owner')
  const changed = source.replace(mutation.before, mutation.after)
  changes.push({ path, sourceSHA256: digest, loadedSHA256: hash(changed), original: source, changed, productionWritten: false })
  return changed
}
async function run(label, mutation) {
  await assertWorkspaceDistBuiltFromCurrentSource(repository)
  assert.equal(hash(await readFile(join(repository, 'pnpm-lock.yaml'))), dependencyLockSHA256, 'All proof builds consume the same dependency lock')
  const directory = join(root, label), out = join(directory, 'renderer'); await mkdir(directory, { recursive: true })
  const consumed = {}, dependencies = {}, changes = []
  const record = async path => {
    if (!path.startsWith(repository + '/') || path.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|css|json)$/.test(path)) return
    const source = await readFile(path, 'utf8'), name = relative(repository, path)
    consumed[name] = hash(source)
    return transformSource(source, name, mutation, changes)
  }
  const esPlugin = { name: 'same-ui-layering-main-input', setup(builder) {
    // Main consumes the same external ESM Core as the product. Its actual loader
    // bytes are observed below; bundling this package into CJS changes its contract.
    builder.onResolve({ filter: /^@agentmux\/core(?:\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
    builder.onLoad({ filter: /\.(?:ts|tsx)$/ }, async args => {
      const source = await record(args.path)
      return source === undefined ? undefined : { contents: source, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
    })
  } }
  for (const entry of ['main', 'preload']) await esbuild.build({ absWorkingDir: repository, entryPoints: [join(fixture, entry + '.ts')],
    outfile: join(directory, entry === 'main' ? 'main.mjs' : 'preload.cjs'), bundle: true, platform: 'node', format: entry === 'main' ? 'esm' : 'cjs',
    ...(entry === 'main' ? { banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } } : {}),
    external: ['electron'], logLevel: 'silent', plugins: [esPlugin] })
  // Observe the unmodified Node loader before Main imports external Core. In
  // particular, a new generated Core file cannot silently escape source binding.
  await writeFile(join(directory, 'bootstrap.cjs'), `
const { registerHooks } = require('node:module');
const { readFileSync, appendFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    if (file.startsWith(${JSON.stringify(repository + '/')}) && !file.startsWith(${JSON.stringify(directory + '/')})) {
      const bytes = loaded.source ?? readFileSync(file);
      appendFileSync(${JSON.stringify(join(directory, 'node-loads.ndjson'))}, JSON.stringify({ file, sha256: createHash('sha256').update(bytes).digest('hex') }) + '\\n');
    }
  }
  return loaded;
} });
import('./main.mjs').catch(error => { console.error(error); require('electron').app.exit(1); });
`)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases }, worker: { format: 'es' },
    plugins: [{ name: 'same-ui-layering-renderer-input', enforce: 'pre', async transform(source, id) {
      if (!id.startsWith(repository + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[jt]sx?$/.test(id)) return
      const original = await readFile(id, 'utf8'), name = relative(repository, id); consumed[name] = hash(original)
      const changed = transformSource(original, name, mutation, changes)
      if (changed !== original) return changed
    }, async generateBundle() { for (const watchedPath of this.getWatchFiles()) {
      const file = resolve(fixture, watchedPath)
      if (file.includes('/node_modules/') && /\.(?:[cm]?js|css|json)$/.test(file)) {
        const name = relative(repository, file), digest = hash(await readFile(file)); dependencies[name] = digest
        if (dependencyInputs.has(name)) assert.equal(digest, dependencyInputs.get(name), 'Every build consumes the same actual installed dependency bytes: ' + name)
        else dependencyInputs.set(name, digest)
      }
      else if (file.endsWith('.css')) await record(file)
      else if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && /\.(?:png|svg|woff2?|ttf)$/.test(file)) {
        const name = relative(repository, file), digest = hash(await readFile(file)); consumed[name] = digest
        if (originalInputs.has(name)) assert.equal(digest, originalInputs.get(name), 'All builds consume the same original asset: ' + name)
        else originalInputs.set(name, digest)
      }
    } } }],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { desktop: join(fixture, 'index.html'), mobile: join(fixture, 'mobile.html') } }, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  for (const path of ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/ConfirmationDialog.tsx',
    'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'apps/desktop/src/renderer/src/lib/workbench-window-registry.ts',
    'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts', 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts',
    'apps/desktop/src/main/native-overlay-surfaces.ts', 'packages/client-ui/src/components/Modal.tsx', 'apps/mobile/src/conversation/MobileMailbox.tsx', 'apps/mobile/src/mobile.css']) assert.ok(consumed[path], 'Nonempty actual product consumer compiled: ' + path)
  assert.equal(changes.length, mutation ? 1 : 0, 'Only the selected actual product source is privately mutated once')
  for (const change of changes) {
    await writeFile(join(directory, 'mutation-original.txt'), change.original); await writeFile(join(directory, 'mutation-loaded.txt'), change.changed)
    delete change.original; delete change.changed
  }
  const compiled = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name)
    if (/\.(?:m?js|cjs|css|html)$/.test(path)) compiled[relative(directory, path)] = hash(await readFile(path))
  }
  const identity = { consumed, dependencies, compiled, changes, dependencyLockSHA256 }
  await writeFile(join(directory, 'inputs.json'), JSON.stringify(identity, null, 2))
  const env = { ...process.env, AGENTMUX_UI_LAYERING_ROOT: directory, AGENTMUX_UI_LAYERING_HTML: join(out, 'index.html'), AGENTMUX_UI_LAYERING_MOBILE_HTML: join(out, 'mobile.html'),
    AGENTMUX_UI_LAYERING_MOBILE_ONLY: mobileOnly ? '1' : '0', AGENTMUX_UI_LAYERING_FULLSCREEN_ONLY: fullscreenOnly ? '1' : '0',
    AGENTMUX_UI_LAYERING_WITHOUT_SYSTEM_FULLSCREEN: withoutSystemFullscreen ? '1' : '0' }; delete env.ELECTRON_RUN_AS_NODE
  // OS capture belongs to the candidate and restored candidate. A deliberately broken
  // mutation still retains native owner/input facts without multiplying OS work.
  if (mutation) delete env.AGENTMUX_VISUAL_ORCA_CLI
  const lines = [], processReceipt = await runProbeProcess(require('electron'), [join(directory, 'bootstrap.cjs')], {
    cwd: repository, env, temporaryRoot: directory, timeoutMs: 180000, onLine: line => lines.push(line)
  })
  await writeFile(join(directory, 'process.log'), lines.join('\n')); await writeFile(join(directory, 'process.json'), JSON.stringify(processReceipt, null, 2))
  await stopProbeProcesses(processReceipt.originalPid, directory)
  const remaining = await listProbeProcesses(processReceipt.originalPid, directory)
  assert.deepEqual(remaining, [], 'Only exact private probe descendants are eligible for cleanup')
  assert.equal(processReceipt.timedOut, false, 'A process timeout cannot count as mutation evidence')
  assert.equal(processReceipt.exitConfirmed, true)
  const nodeLoads = (await readFile(join(directory, 'node-loads.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(nodeLoads.some(row => row.file.endsWith('/packages/core/dist/index.js')), 'The actual external Core entry must be observed')
  for (const { file, sha256: digest } of nodeLoads) {
    const name = relative(repository, file), inputs = file.includes('/node_modules/') ? dependencyInputs : originalInputs
    assert.equal(hash(await readFile(file)), digest, 'Actual external Node input remains unchanged: ' + name)
    if (inputs.has(name)) assert.equal(digest, inputs.get(name), 'Every run loads the same actual external Node input: ' + name)
    else inputs.set(name, digest)
    ;(file.includes('/node_modules/') ? dependencies : consumed)[name] = digest
  }
  const receipt = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
  if (!mutation && !mobileOnly && !fullscreenOnly) {
    const assets = Object.keys(receipt.avatar?.sourceInputs ?? {})
    assert.ok(assets.some(name => name.endsWith('.glb')) && assets.some(name => name.endsWith('/series.json')),
      'The actual Avatar combination must bind nonempty original GLB and catalog source bytes')
  }
  for (const [name, digest] of Object.entries(receipt.avatar?.sourceInputs ?? {})) {
    assert.equal(hash(await readFile(join(repository, name))), digest, 'Original Avatar source bytes remain unchanged: ' + name)
    if (originalInputs.has(name)) assert.equal(digest, originalInputs.get(name), 'Every run consumes the same original Avatar source: ' + name)
    else originalInputs.set(name, digest)
    consumed[name] = digest
  }
  identity.nodeLoads = nodeLoads
  await writeFile(join(directory, 'inputs.json'), JSON.stringify(identity, null, 2))
  const row = { label, expected: mutation ? 'RED' : partial ? 'AVAILABLE_CHECKS' : 'COMPLETE', directory: relative(root, directory), passed: receipt.passed,
    availableChecksPassed: receipt.availableChecksPassed, completeGate: receipt.completeGate, uncovered: receipt.uncovered, caseCount: receipt.cases.length,
    receiptSHA256: hash(await readFile(join(directory, 'result.json'))), failure: receipt.failure, changes, frames: receipt.frames, chromeFrames: receipt.chromeFrames, osFrames: receipt.osFrames }
  results.push(row)
  if (!mutation) evidence.uncovered = [...new Set([...evidence.uncovered, ...(row.uncovered ?? [])])]
  if (mutation) {
    assert.equal(processReceipt.exitCode, 1, 'Mutant must fail through the actual product chain')
    assert.equal(receipt.passed, false); assert.match(receipt.failure?.message ?? '', mutation.expected)
    assert.ok(receipt.publications.some(publication => publication.regions.some(region => region.modal?.part === 'content')), 'Mutation must reach nonempty real modal content')
  } else {
    assert.equal(processReceipt.exitCode, 0, receipt.failure?.message ?? `Coverage gates remain open: ${(receipt.uncovered ?? []).join(', ')}`)
    assert.equal(receipt.availableChecksPassed, true, 'All requested available product checks must pass')
    if (!partial) assert.equal(receipt.completeGate, true, 'Default mode requires every coverage gate, including system fullscreen and OS composition')
    if (partial) { assert.equal(receipt.completeGate, false); assert.equal(receipt.passed, false, 'Partial evidence cannot claim complete success') }
    const systemFullscreen = ['system-fullscreen-enter', 'system-fullscreen-restored', 'system-fullscreen-preserves-original-input-and-draft']
    const required = fullscreenOnly ? systemFullscreen : ['mobile-mailbox-image-window-sibling-escape', 'mobile-mailbox-image-window-sibling-control', ...(!mobileOnly ? [
      'normal-stop-original-caller', 'initial-enter-cancels', 'native-keep-original-session', 'native-stop-busy-exactly-once', 'narrow-short', 'zoom-125',
      'pure-layout-displacement', 'repeated-top-layer-0', 'repeated-top-layer-1', 'independent-document-native-scope-and-cancel',
      'atomic-preparation-background-input-guard', 'required-content-failure-retry-retains-request', 'accessory-failure-retains-parent-modal',
      'nested-menu-tooltip-scope-and-one-escape', 'focusable-completion-and-editor-retained-through-retry',
      'mote-avatar-series-native-layer-and-continuous-paint',
      'stable-workbench-original-form-cross-document-roundtrip', 'same-runtime-two-document-modal-focus-and-single-dismissal',
      ...(process.platform === 'darwin' ? ['simple-fullscreen', 'simple-fullscreen-restored', ...(!withoutSystemFullscreen ? systemFullscreen : [])] : [])] : [])]
    for (const label of required) assert.ok(receipt.cases.some(row => row.label === label), 'Candidate must reach the actual nonempty required case: ' + label)
    if (!mobileOnly && !fullscreenOnly) for (const label of ['normal-stop', 'nested-menu-tooltip', 'content-failure-retry', 'same-request-retry', 'avatar-series-initial', 'avatar-series-drag']) {
      const frame = receipt.frames.find(row => row.label === label)
      assert.ok(frame?.chrome?.some(owner => !owner.scrim && owner.paintedPixels > 0), 'The exact native Chrome compositor must supply painted pixels for: ' + label)
    }
    if (withoutSystemFullscreen) {
      assert.ok(receipt.uncovered.includes('native-system-fullscreen'))
      assert.equal(receipt.systemFullscreen?.status, 'not-requested', 'Explicit partial mode must not resend the unconfirmed OS request')
      assert.equal(receipt.systemFullscreen?.events, undefined)
    }
  }
  console.log(label + ': ' + (mutation ? 'expected RED' : partial ? 'available checks passed — PARTIAL; completeGate=false' : 'all machine coverage gates passed; independent image review pending'))
}
try {
  if (!mobileOnly && !fullscreenOnly) assert.equal(candidate.started.clean, true, 'The complete requested matrix must consume a clean committed candidate; scoped development checks retain their dirty identity')
  await run('candidate')
  if (process.argv.includes('--mutations')) { for (const mutation of mutations) await run(mutation.label, mutation); await run('restored') }
  evidence.sourceInputs = Object.fromEntries(originalInputs)
  evidence.sourceDigest = hash(JSON.stringify([...originalInputs].sort(([a], [b]) => a.localeCompare(b))))
  evidence.dependencyLockSHA256 = dependencyLockSHA256
  evidence.dependencyInputs = Object.fromEntries(dependencyInputs)
  evidence.dependencyInputDigest = hash(JSON.stringify([...dependencyInputs].sort(([a], [b]) => a.localeCompare(b))))
  for (const [path, digest] of originalInputs) assert.equal(hash(await readFile(join(repository, path))), digest, 'Candidate inputs remain unchanged; rerun if concurrent product edits changed them: ' + path)
  for (const [path, digest] of dependencyInputs) assert.equal(hash(await readFile(join(repository, path))), digest, 'Actual installed dependency bytes remain unchanged: ' + path)
  evidence.availableChecksPassed = true
  const originals = results.filter(row => row.expected !== 'RED')
  evidence.uncovered = [...new Set(originals.flatMap(row => row.uncovered ?? []))]
  evidence.completeGate = !partial && originals.every(row => row.completeGate) && evidence.uncovered.length === 0
  evidence.passed = evidence.completeGate
} catch (error) { evidence.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  try {
    candidate.finished = candidateIdentity()
    assert.deepEqual(candidate.finished, candidate.started, 'The original Git candidate identity must remain unchanged through the actual proof run')
    for (const [path, digest] of Object.entries(harnessInputs)) assert.equal(hash(await readFile(join(repository, path))), digest, 'The original proof harness input must remain unchanged: ' + path)
    candidate.unchanged = true
  } catch (error) {
    evidence.identityFailure = { name: error.name, message: error.message, stack: error.stack }
    evidence.passed = false; evidence.availableChecksPassed = false; evidence.completeGate = false; process.exitCode = 1
  }
  await writeFile(join(root, 'receipt.json'), JSON.stringify(evidence, null, 2))
  const candidateResult = results.find(result => result.label === 'candidate')
  await writeFile(join(root, 'review.md'), ['# UI layering — independent image review pending', '',
    `Scope: ${evidence.scope}. availableChecksPassed=${evidence.availableChecksPassed}; completeGate=${evidence.completeGate}. Uncovered: ${evidence.uncovered.join(', ') || 'none'}.`, '',
    'Read the complete actual candidate OS window screenshots. Separate Renderer/native PNGs are diagnostic scope only and are never an OS screenshot.', '',
    'Actual Workbench close → shared modal → native Chrome projection and trusted input. Preview Agent/Browser facts only; no user Session was stopped. Capture success does not sign aesthetic approval.', '',
    ...(candidateResult?.osFrames ?? []).map(frame => `- ${frame.label}: [OS window](candidate/${frame.file}) · [identity/owners](candidate/${frame.metadata})`),
    ...(!candidateResult?.osFrames?.length ? ['No actual OS window screenshot was captured. Do not sign compositor visual approval.'] : []), '',
    'Actual Chrome WebContents compositor readbacks (capturePage may request a frame; these are not first-presentation or host-window composition proof):', '',
    ...(candidateResult?.chromeFrames ?? []).map(frame => `- ${frame.label} · original View ${frame.before.webContentsId} / Window ${frame.before.windowId}: [Chrome pixels](candidate/${frame.file})`), '',
    'Review: Stop readability above scrim/Browser, action priority, narrow/short/125% fit, failure service window, retained content, nested control clarity. Record exact images opened, concrete issues and explicit delivery conclusion.', ''].join('\n'))
  console.log(JSON.stringify({ passed: evidence.passed, availableChecksPassed: evidence.availableChecksPassed, completeGate: evidence.completeGate,
    uncovered: evidence.uncovered, receipt: join(root, 'receipt.json'), failure: evidence.failure ?? null }))
}
