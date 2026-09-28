import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { build } from 'vite'
import { listProbeProcesses, runProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/mote-navigation-footer')
const require = createRequire(join(desktop, 'package.json'))
const args = process.argv.slice(2)
let selectedFrames = null, candidateFile = null
if (args[0] === '--reuse') {
  const { recapture } = await import('./fixtures/mote-navigation-footer/recapture.mjs')
  await recapture({ desktop, repository, fixture, driver: import.meta.filename }, args)
  process.exit(0)
}
if (args.length) {
  assert.equal(args.length, 4, 'Use --capture affected-entry --candidate <manifest.json>')
  assert.deepEqual(args.slice(0, 3), ['--capture', 'affected-entry', '--candidate'])
  candidateFile = resolve(repository, args[3])
  selectedFrames = ['wide-closed-low-footer-circle', 'wide-hover-cards-original-input',
    'narrow-long-names-all-motes-cards', 'narrow-avatars-custom-original-draft',
    'settings-bridge-original-mote-input-unsent', 'settings-retained-circle-entry-focus']
}
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-presentation-'))
const evidence = join(repository, '.tmp/mote-navigation-footer', `attempt-${Date.now()}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), originalBytes = new Map(), styles = new Set(), watchedStyles = new Set()
const local = file => file?.startsWith(repository + '/') && !file.includes('/node_modules/')
const localStyle = file => local(file) && file.endsWith('.css')
const sourceBinding = {
  name: 'bind-mote-presentation-original-inputs', enforce: 'pre',
  async load(id) {
    const file = id.split('?')[0]
    if (local(file) && !inputs.has(file)) {
      const bytes = await readFile(file)
      inputs.set(file, hash(bytes)); originalBytes.set(file, bytes)
    }
    // Vite's ordinary transforms consume these exact original text bytes. CSS
    // keeps its maintained loader and is independently bound at PostCSS Input.
    if (!id.includes('?') && originalBytes.has(file) && /\.[cm]?[jt]sx?$/.test(file)) {
      return { code: originalBytes.get(file).toString('utf8'), map: null }
    }
    return null
  },
  buildEnd() {
    for (const file of this.getWatchFiles()) if (localStyle(file)) {
      watchedStyles.add(file)
      assert.ok(styles.has(file), `No consumed original CSS: ${relative(repository, file)}`)
    }
  }
}
const stylesheetBinding = {
  postcssPlugin: 'bind-mote-presentation-original-styles',
  async Once(root) {
    const consumed = new Map()
    const remember = node => {
      const input = node.source?.input
      if (localStyle(input?.file)) consumed.set(input.file, input.css)
    }
    remember(root); root.walk(remember)
    for (const [file, css] of consumed) {
      const digest = hash(css)
      assert.equal(hash(await readFile(file)), digest, `CSS changed while consumed: ${relative(repository, file)}`)
      if (inputs.has(file)) assert.equal(inputs.get(file), digest, 'Loader and PostCSS bytes agree')
      inputs.set(file, digest); originalBytes.set(file, Buffer.from(css)); styles.add(file)
    }
  }
}
const result = {
  schema: 'agentmux.mote-navigation-footer-renderer.v1', passed: false,
  captureOnly: true, aestheticReview: 'not-performed', userAppOrRunTouched: false,
  sourceScope: 'Actual production App and Renderer components; WEB_PREVIEW controlled data boundary.',
  limitations: [
    'One private Renderer compile and one Electron process. No Core/desktop formal build, package, install, restart or two-process proof.',
    'Controlled typed Session/Topic/timeline data and side-effect sinks do not prove attachment, SDK, Core/ctxmux Run or real CLI survival.',
    'capturePage contains Renderer pixels only; no native WebContentsView, OS composition, physical input or OS IME sign-off.',
    'Optional separately owned native supplement consumes these exact archived Renderer bytes and carries its own input/Source receipt.',
    'Imported local generated dependencies are byte-bound inputs, not a claim that their Core Source was verified.'
  ], stage: 'preparation', cleanup: null
}
if (selectedFrames) {
  result.captureSelection = { mode: 'affected-entry', frames: selectedFrames,
    scope: 'New actual Renderer compilation and six new affected frames; all eight original interactions/assertions replayed. The prior wide avatar and light images retain their original scope, not new candidate screenshots.' }
}
await mkdir(evidence, { recursive: true })
try {
  if (candidateFile) {
    const bytes = await readFile(candidateFile), candidate = JSON.parse(bytes)
    assert.ok(candidate.files.length > 0, 'The coherent Source candidate must be nonempty')
    for (const row of candidate.files) assert.equal(hash(await readFile(join(repository, row.path))), row.sha256, 'Candidate inputs agree before actual compilation')
    result.candidate = { path: candidateFile, sha256: hash(bytes), files: candidate.files }
    await writeFile(join(evidence, 'candidate.json'), bytes)
  }
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'),
    ...['index.html', 'entry.tsx', 'main.cjs', 'scenario.md'].map(name => join(fixture, name))]) {
    const bytes = await readFile(file)
    inputs.set(file, hash(bytes)); originalBytes.set(file, bytes)
  }
  result.stage = 'private-renderer-compile'
  const outDir = join(privateRoot, 'renderer')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [sourceBinding], css: { postcss: { plugins: [stylesheetBinding] } },
    build: { target: 'esnext', outDir, emptyOutDir: true, minify: false } })
  assert.ok(inputs.size > 0, 'Imported input graph must be nonempty')
  assert.ok(styles.size > 1, 'Original consumed local style graph must be nonempty')
  assert.ok(watchedStyles.size > 1, 'Actual Vite watched style graph must be nonempty')
  assert.deepEqual([...styles].sort(), [...watchedStyles].sort(), 'Every actual watched style has original consumed bytes')
  for (const owner of ['App.tsx', 'PmoTeamsTopicEntry.tsx', 'PmoTeamsTopicFloatingPanel.tsx',
    'TopRowChrome.tsx', 'SettingsPanel.tsx', 'WorkspaceWorkbench.tsx', 'AgentSessionComposer.tsx']) {
    assert.ok([...inputs.keys()].some(file => file.endsWith('/' + owner)), `Actual production owner not compiled: ${owner}`)
  }
  for (const name of ['index.css', 'agent.css', 'pmo-teams-topic.css']) {
    assert.ok([...styles].some(file => file.endsWith('/styles/' + name)), `Actual style missing: ${name}`)
  }
  result.inputs = Object.fromEntries([...inputs].map(([file, digest]) => [relative(repository, file), digest]))
  result.stylesheets = Object.fromEntries([...styles].sort().map(file => [relative(repository, file), inputs.get(file)]))
  result.watchedStylesheets = [...watchedStyles].sort().map(file => relative(repository, file))
  result.compiled = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name)
    result.compiled[relative(outDir, file)] = hash(await readFile(file))
  }
  assert.ok(Object.keys(result.compiled).length > 0, 'Compiled output must be nonempty')
  // Preserve this exact compilation for independent native supplementation.
  await cp(outDir, join(evidence, 'renderer'), { recursive: true })
  for (const [file, bytes] of originalBytes) {
    const target = join(evidence, 'original-inputs', relative(repository, file))
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, bytes)
  }
  result.compiledRenderer = join(evidence, 'renderer')
  result.originalInputs = join(evidence, 'original-inputs')
  await writeFile(join(evidence, 'compiled-receipt.json'), JSON.stringify({
    schema: result.schema, stage: 'compiled-only', inputs: result.inputs,
    stylesheets: result.stylesheets, watchedStylesheets: result.watchedStylesheets,
    compiled: result.compiled, compiledRenderer: result.compiledRenderer, originalInputs: result.originalInputs,
    sourceScope: result.sourceScope, limitations: result.limitations,
    ...(result.candidate ? { candidate: result.candidate, captureSelection: result.captureSelection } : {})
  }, null, 2))
  console.log(JSON.stringify({ stage: 'compiled-only', compiledRenderer: result.compiledRenderer,
    receipt: join(evidence, 'compiled-receipt.json'), originalInputs: result.originalInputs }))
  result.stage = 'single-private-renderer-process'
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  result.exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'),
    join(outDir, 'index.html'), privateRoot, evidence, ...(selectedFrames ? [JSON.stringify(selectedFrames)] : [])], {
    temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000,
    onLine: line => logs.push(line)
  })
  await writeFile(join(evidence, 'renderer.log'), logs.join('\n'))
  result.renderer = JSON.parse(await readFile(join(evidence, 'renderer.json'), 'utf8'))
  assert.equal(result.exit.timedOut, false, 'The bounded Renderer must publish a result')
  assert.equal(result.exit.exitCode, 0, result.renderer.failure?.message)
  assert.equal(result.renderer.passed, true)
  assert.equal(result.renderer.frames.length, selectedFrames ? 6 : 8, 'Every selected actual frame must be captured')
  if (selectedFrames) assert.deepEqual(result.renderer.frames.map(frame => frame.name), selectedFrames)
  assert.equal(result.renderer.replayedFrames.length, 8, 'All original actual interactions and assertions are retained')
  for (const frame of result.renderer.frames) {
    assert.equal(hash(await readFile(join(evidence, frame.file))), frame.sha256, 'Actual frame bytes agree')
  }
  result.stage = 'source-style-and-compiled-final-binding'
  for (const [file, digest] of inputs) {
    assert.equal(hash(await readFile(file)), digest, `Input changed during capture: ${relative(repository, file)}`)
    assert.equal(hash(await readFile(join(result.originalInputs, relative(repository, file)))), digest, 'Archived original bytes agree')
  }
  for (const [name, digest] of Object.entries(result.compiled)) {
    assert.equal(hash(await readFile(join(evidence, 'renderer', name))), digest, 'Archived compilation agrees')
  }
  for (const row of result.candidate?.files ?? []) assert.equal(hash(await readFile(join(repository, row.path))), row.sha256, 'Candidate remains coherent after capture')
  result.passed = true; result.stage = 'captured-independent-look-pending'
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  result.inputFreshnessAtFinish = { checked: inputs.size, changed: [] }
  for (const [file, digest] of inputs) {
    const actual = await readFile(file).then(hash).catch(() => null)
    if (actual !== digest) result.inputFreshnessAtFinish.changed.push({
      path: relative(repository, file), captured: digest, actual
    })
  }
  if (result.inputFreshnessAtFinish.changed.length) {
    result.passed = false
    result.sourceDrift = true
  }
  // Partial images/results remain reviewable even when a later stage failed.
  const phase = await readFile(join(evidence, 'renderer.json'), 'utf8').catch(() => null)
  if (!result.renderer && phase) {
    try { result.renderer = JSON.parse(phase) }
    catch (error) { result.partialResultUnreadable = String(error) }
  }
  result.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), privateRootRemoved: false }
  if (!result.cleanup.remaining.length) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
  await writeFile(join(evidence, 'review.md'), [
    '# Mote rail / footer / Settings — independent actual look pending', '',
    `Capture passed: ${result.passed}. Stage: ${result.stage}. This is a single private Renderer capture, not native/OS/Core Run sign-off.`, '',
    ...(result.renderer?.frames ?? []).map(frame => `- ${frame.name}: [Actual complete Renderer frame](${frame.file}) — ${frame.sha256}`), '',
    'Open every frame. Review both rail forms, complete objects and original input, narrow long names, dark/light boundary, low bar and complete circle/status/focus, and Settings operability.',
    'Original inputs/raw CSS/compiled bytes and actual geometry/events are in receipt.json. Capture success does not constitute aesthetic approval.'
  ].join('\n'))
}
console.log(JSON.stringify({ passed: result.passed, stage: result.stage,
  receipt: join(evidence, 'receipt.json'), compiled: result.compiledRenderer, cleanup: result.cleanup, failure: result.failure }))
assert.equal(result.cleanup.remaining.length, 0, 'Preserve unconfirmed private process roots')
assert.equal(result.cleanup.privateRootRemoved, true)
assert.equal(result.passed, true, result.failure?.message)
