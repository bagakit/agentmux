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
let selectedFrames = null, candidateFile = null, footerOnly = false, floatingResize = false, moteIdentity = false, moteArchive = false, motePaperdoll = false, reuseRenderer = null
if (args[0] === '--reuse') {
  const { recapture } = await import('./fixtures/mote-navigation-footer/recapture.mjs')
  await recapture({ desktop, repository, fixture, driver: import.meta.filename }, args)
  process.exit(0)
}
if (args.length) {
  assert.ok(args.length === 4 || args.length === 6, 'Use --capture affected-entry|footer-only|floating-resize|mote-identity|mote-archive|mote-paperdoll --candidate <manifest.json> [--reuse-renderer <compiled-receipt.json>]')
  assert.equal(args[0], '--capture'); assert.equal(args[2], '--candidate')
  assert.ok(['affected-entry', 'footer-only', 'floating-resize', 'mote-identity', 'mote-archive', 'mote-paperdoll'].includes(args[1]))
  moteIdentity = args[1] === 'mote-identity'
  moteArchive = args[1] === 'mote-archive'
  motePaperdoll = args[1] === 'mote-paperdoll'
  footerOnly = args[1] === 'footer-only'
  floatingResize = args[1] === 'floating-resize'
  if (args.length === 6) {
    assert.ok(footerOnly || floatingResize || moteArchive); assert.equal(args[4], '--reuse-renderer')
    reuseRenderer = resolve(repository, args[5])
  }
  candidateFile = resolve(repository, args[3])
  selectedFrames = motePaperdoll ? ['paperdoll-primary-default', 'paperdoll-editor-preview', 'paperdoll-thinking-tool', 'paperdoll-narrow-idle', 'paperdoll-restored-sleep', 'paperdoll-unconfirmed-unknown'] : moteArchive ? ['archive-wide-cards-menu', 'archive-narrow-avatars-current', 'archive-space-discover-restore', 'archive-restored-original-workface', 'archive-save-unconfirmed-unknown'] : moteIdentity ? ['identity-wide-cards', 'identity-wide-avatars', 'identity-narrow-cards', 'identity-narrow-avatars', 'identity-save-unconfirmed', 'identity-full-space'] : floatingResize ? ['resize-wide-cards', 'resize-wide-avatars', 'resize-narrow-cards', 'resize-narrow-avatars', 'resize-storage-issue'] : footerOnly ? ['footer-320-dark-double-counts', 'footer-420-dark-double-counts',
    'footer-560-dark-double-counts', 'footer-980-dark-double-counts', 'footer-320-light-double-counts'] : ['wide-closed-low-footer-circle', 'wide-hover-cards-original-input',
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
  result.captureSelection = { mode: motePaperdoll ? 'mote-paperdoll' : moteArchive ? 'mote-archive' : moteIdentity ? 'mote-identity' : floatingResize ? 'floating-resize' : footerOnly ? 'footer-only' : 'affected-entry', frames: selectedFrames,
    scope: motePaperdoll ? 'One actual App Renderer with the maintained React profiling renderer; original picker/appearance owner, exact single-bridge live events and current ScratchTopics image owner. Same profile, two private processes, six complete frames and native animation/cost evidence; no Core Run or native-stage claim.' : moteArchive ? 'One actual App Renderer compilation; two independent private Electron phases consume the same original profile, real ScratchTopics Source/typed IPC and durable writer. Five complete archive/Space/restore/failure frames. No old matrix, Core Run or native-stage claim.' : moteIdentity ? 'One actual App Renderer compilation, original image picker and real ScratchTopics asset/ordinary initialization owner in a private process, four rail geometries, save failure and Space identity, same-profile Renderer reload. Six complete frames; no Core Run/native claim.' : floatingResize ? 'One actual App Renderer compile: bounded resize, both rail forms, narrow viewport, cancel, advisory storage failure/recovery and reload proof. Five complete frames; no old Footer/native or eight-flow replay.' : footerOnly ? 'One actual Renderer compile; sixteen Footer count geometry cases, five frames and isolated exact CSS-source mutation RED / original-source GREEN. Other rail/Settings/native evidence retains its earlier scope.' :
      'New actual Renderer compilation and six new affected frames; all eight original interactions/assertions replayed. The prior wide avatar and light images retain their original scope, not new candidate screenshots.' }
}
await mkdir(evidence, { recursive: true })
try {
  if (candidateFile) {
    const bytes = await readFile(candidateFile), candidate = JSON.parse(bytes)
    assert.ok(candidate.files.length > 0, 'The coherent Source candidate must be nonempty')
    for (const row of candidate.files) assert.equal(hash(await readFile(join(repository, row.path))), row.sha256, 'Candidate inputs agree before actual compilation')
    if ((floatingResize || moteArchive) && candidate.compiledReuse && !reuseRenderer) {
      reuseRenderer = resolve(repository, candidate.compiledReuse.path)
      assert.equal(hash(await readFile(reuseRenderer)), candidate.compiledReuse.sha256, 'Explicit candidate reuse receipt identity agrees')
    }
    result.candidate = { path: candidateFile, sha256: hash(bytes), files: candidate.files, ...(candidate.compiledReuse ? { compiledReuse:candidate.compiledReuse } : {}) }
    await writeFile(join(evidence, 'candidate.json'), bytes)
  }
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'),
    ...(motePaperdoll ? ['paperdoll.html', 'paperdoll-entry.tsx', 'paperdoll-main.cjs', 'paperdoll-preload.cjs'] : moteArchive ? ['archive.html', 'archive-entry.tsx', 'archive-main.cjs', 'archive-preload.cjs'] : ['index.html', 'entry.tsx', 'main.cjs', 'scenario.md', ...(moteIdentity ? ['identity-main.cjs', 'identity-preload.cjs'] : [])]).map(name => join(fixture, name))]) {
    const bytes = await readFile(file)
    inputs.set(file, hash(bytes)); originalBytes.set(file, bytes)
  }
  result.stage = 'private-renderer-compile'
  const outDir = join(privateRoot, 'renderer')
  if (reuseRenderer) {
    const parentBytes = await readFile(reuseRenderer), parent = JSON.parse(parentBytes)
    assert.ok(Object.keys(parent.inputs).length > 100 && Object.keys(parent.compiled).length > 0)
    for (const [file, digest] of Object.entries(parent.inputs)) {
      const original = await readFile(join(parent.originalInputs, file))
      assert.equal(hash(original), digest, 'Every original consumed input remains byte-bound')
      const absolute = join(repository, file)
      if (!inputs.has(absolute)) { inputs.set(absolute, digest); originalBytes.set(absolute, original) }
    }
    for (const [file, digest] of Object.entries(parent.stylesheets)) {
      assert.equal(parent.inputs[file], digest); styles.add(join(repository, file)); watchedStyles.add(join(repository, file))
    }
    for (const [file, digest] of Object.entries(parent.compiled)) {
      assert.equal(hash(await readFile(join(parent.compiledRenderer, file))), digest, 'Every original compiled byte agrees')
    }
    // A corrected Node capture/assertion driver does not change compiled Renderer inputs.
    for (const row of result.candidate.files.filter(row => floatingResize || moteArchive ? /^(apps\/desktop\/src\/renderer\/src\/|apps\/desktop\/scripts\/fixtures\/mote-navigation-footer\/(?:archive-)?entry\.tsx$)/.test(row.path) && /\.(?:[jt]sx?|css)$/.test(row.path) : /\.(tsx|css)$/.test(row.path))) {
      assert.equal(parent.inputs[row.path], row.sha256, 'Current task Renderer producers, including floating size/persistence lib.ts, agree with the reused compilation')
    }
    await cp(parent.compiledRenderer, outDir, { recursive: true })
    result.reusedCompilation = { receipt: reuseRenderer, sha256: hash(parentBytes), compiled: parent.compiled,
      scope: 'Unchanged original actual Renderer compilation; current separately bound Node capture/assertion driver. No Renderer recompile.' }
  } else {
    const aliases = []
    if (moteIdentity || moteArchive || motePaperdoll) for (const name of ['core', 'demand', 'layout']) {
      const manifest = JSON.parse(await readFile(join(repository, 'packages', name, 'package.json'), 'utf8'))
      const exports = Object.entries(manifest.exports)
      assert.ok(exports.length > 0)
      for (const [subpath, target] of exports) {
        const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
        const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
        aliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: join(repository, 'packages', name, source) })
      }
    }
    if (motePaperdoll) aliases.push({ find: /^react-dom\/client$/, replacement: require.resolve('react-dom/profiling') })
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases },
    esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [sourceBinding], css: { postcss: { plugins: [stylesheetBinding] } },
    build: { target: 'esnext', outDir, emptyOutDir: true, minify: false,
      ...(motePaperdoll ? { rollupOptions: { input: join(fixture, 'paperdoll.html') } } : moteArchive ? { rollupOptions: { input: join(fixture, 'archive.html') } } : {}) } })
  }
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
  if (moteIdentity) {
    const producers = result.candidate.files.filter(row => row.path.startsWith('apps/desktop/src/renderer/src/') || row.path === 'apps/desktop/src/shared/mote-avatars.ts' || row.path.endsWith('/mote-navigation-footer/entry.tsx'))
    assert.ok(producers.length >= 12, 'Avatar production producer set includes the original consumers, picker, state and typed contract')
    for (const row of producers) assert.equal(inputs.get(join(repository, row.path)), row.sha256, 'Actual compiled avatar producer consumes candidate bytes')
    for (const name of ['SpaceObjectIcon.tsx', 'SpaceIconPicker.tsx', 'MoteAvatarCrop.tsx']) assert.ok([...inputs.keys()].some(file => file.endsWith('/' + name)), 'Actual avatar owner not compiled: ' + name)
    assert.ok([...styles].some(file => file.endsWith('/styles/space-object-appearance.css')), 'Original avatar style is consumed')
    result.sourceScope = 'Actual production App Renderer and current real ScratchTopics/WorkspaceFiles Source owners; controlled external Session facts and typed Main bridge in a private process.'
    result.limitations[1] = 'Real current Topic initialization, image assets and final file guards; controlled external Session/timeline facts and action sinks do not prove attachment, SDK, Core/ctxmux Run or real CLI survival.'
    result.limitations[4] = 'Current Core/demand/layout Source is byte-bound to this Renderer compilation; no Core build or runtime lifecycle claim.'
  }
  if (floatingResize) {
    const producers = result.candidate.files.filter(row =>
      row.path.startsWith('apps/desktop/src/renderer/src/') || row.path.endsWith('/mote-navigation-footer/entry.tsx'))
    assert.ok(producers.length >= 4, 'Resize producer set is nonempty, including lib/Panel/CSS/entry')
    assert.ok(producers.some(row => row.path.endsWith('/lib/pmo-teams-topic-floating.ts')), 'The actual size and persistence lib.ts is bound')
    for (const row of producers) assert.equal(inputs.get(join(repository, row.path)), row.sha256, 'Actual compiled resize producer consumes candidate bytes')
  }
  if (moteArchive) {
    const required = ['PmoTeamsTopicFloatingPanel.tsx', 'SpaceTopicsTree.tsx', 'LauncherMoteAction.tsx',
      'SpaceObjectContextMenu.tsx', 'MoteArchiveNotice.tsx', 'scratch-topic-snapshots.ts', 'store.ts', 'archive-entry.tsx']
    for (const name of required) assert.ok([...inputs.keys()].some(file => file.endsWith('/' + name)), 'Actual archive owner not compiled: ' + name)
    const producers = result.candidate.files.filter(row => row.path.startsWith('apps/desktop/src/renderer/src/') || row.path.endsWith('/mote-navigation-footer/archive-entry.tsx'))
    assert.ok(producers.length >= 6, 'Archive candidate includes actual store/action and all three consumers')
    for (const row of producers) assert.equal(inputs.get(join(repository, row.path)), row.sha256, 'Actual compiled archive producer consumes candidate bytes')
    result.sourceScope = 'Actual production App/Renderer and current real ScratchTopics Source through typed private IPC; two independent private processes and original durable writer/profile. External Session facts are controlled.'
    result.limitations[0] = 'One private Renderer compilation and two private Electron phases. No Core/desktop formal build, package, install or user App/Run control.'
    result.limitations[1] = 'Real private archive metadata and ordinary Workbench persistence; controlled Session snapshots/recovery/attachment do not prove actual Core/ctxmux Run or real CLI survival.'
    result.limitations[4] = 'Public Core/demand/layout exports resolve current Source for this probe; no Core build or runtime lifecycle claim. Private IPC mirrors the typed archive API; production IPC wiring is covered by its owning proof.'
  }
  if (motePaperdoll) {
    const producers = result.candidate.files.filter(row => row.path.startsWith('apps/desktop/src/renderer/src/') || row.path === 'apps/desktop/src/shared/mote-avatars.ts' || row.path.endsWith('/paperdoll-entry.tsx'))
    assert.ok(producers.length >= 12, 'Paperdoll candidate includes original editor/consumers/state/event provenance')
    for (const row of producers) assert.equal(inputs.get(join(repository, row.path)), row.sha256, 'Every actual paperdoll producer consumes exact candidate Source')
    for (const name of ['MoteFace.tsx', 'MoteFaceEditor.tsx', 'MoteIdentityMotion.tsx', 'mote-expression.ts', 'SpaceObjectIcon.tsx', 'SpaceIconPicker.tsx', 'session-state.ts', 'session-events.ts']) assert.ok([...inputs.keys()].some(file => file.endsWith('/' + name)), 'Actual face owner not compiled: ' + name)
    const profileSource = require.resolve('react-dom/profiling'), implementation = join(resolve(profileSource, '..'), 'cjs/react-dom-profiling.profiling.js')
    result.instrumentation = { renderer: 'react-dom/profiling', sources: [], observation: 'Maintained React profiling renderer; actual MoteIdentityMotion fiber actualDuration/startTime within the original App Profiler current commit start/end. Stale bailout timing excluded. Hook/Profiler are private in byte-bound paperdoll.html/entry; product components are not replaced.' }
    for (const file of [profileSource, implementation]) {
      const bytes = await readFile(file), preserved = join(evidence, 'instrumentation', file === profileSource ? 'profiling.js' : 'react-dom-profiling.profiling.js')
      await mkdir(resolve(preserved, '..'), { recursive: true }); await writeFile(preserved, bytes)
      result.instrumentation.sources.push({ path: file, sha256: hash(bytes), preserved, bytes: bytes.length })
    }
    result.limitations[0] = 'One private Renderer compilation and two private Electron phases. No formal Core/desktop build, package, install or user App/Run control.'
    result.limitations[1] = 'Real private avatar assets and ordinary durable appearance writer; controlled typed event transport/Session snapshots do not prove Core/ctxmux Run or real CLI survival.'
    result.limitations[4] = 'Public Core/demand/layout exports resolve current Source; no formal build or runtime lifecycle claim.'
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
  result.stage = motePaperdoll ? 'two-private-paperdoll-processes' : moteArchive ? 'two-private-archive-processes' : 'single-private-renderer-process'
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  if (moteArchive || motePaperdoll) {
    result.renderer = { passed: false, phases: [], frames: [], checks: [] }
    for (const phase of ['seed', 'restore']) {
      const destination = join(evidence, phase); await mkdir(destination)
      const phaseLogs = []
      const exit = await runProbeProcess(require('electron'), [join(fixture, motePaperdoll ? 'paperdoll-main.cjs' : 'archive-main.cjs'),
        join(outDir, motePaperdoll ? 'paperdoll.html' : 'archive.html'), privateRoot, destination, phase], {
        temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000, onLine: line => phaseLogs.push(line)
      })
      await writeFile(join(destination, 'renderer.log'), phaseLogs.join('\n'))
      const child = JSON.parse(await readFile(join(destination, 'renderer.json'), 'utf8'))
      result.renderer.phases.push({ phase, exit, renderer: child })
      result.renderer.frames.push(...child.frames.map(frame => ({ ...frame, file: join(phase, frame.file) })))
      result.renderer.checks.push(...child.checks)
      await writeFile(join(evidence, 'renderer.json'), JSON.stringify(result.renderer, null, 2))
      assert.equal(exit.timedOut, false, 'Private archive phase must publish a bounded result')
      assert.equal(exit.exitCode, 0, child.failure?.message); assert.equal(child.passed, true)
      assert.ok(Object.keys(child.inputs).length > 0, 'Current real Main Source input graph must be nonempty')
      assert.ok(child.inputs['apps/desktop/src/main/scratch-topics.ts'], 'Real archive FS owner executes in each process')
      assert.ok(child.inputs['packages/core/src/durable-write.ts'], 'Existing public atomic writer executes from current Source')
      for (const [name, digest] of Object.entries(child.inputs)) {
        const absolute = join(repository, name), bytes = await readFile(join(destination, 'main-original-inputs', name))
        assert.equal(hash(bytes), digest, 'Executed Main original Source bytes are preserved')
        if (inputs.has(absolute)) assert.equal(inputs.get(absolute), digest, 'Renderer and both Main phases consume the same Source')
        else { inputs.set(absolute, digest); originalBytes.set(absolute, bytes) }
        const original = join(result.originalInputs, name); await mkdir(resolve(original, '..'), { recursive: true }); await writeFile(original, bytes)
        assert.equal(hash(await readFile(join(destination, 'main-transformed', name.replace(/\.ts$/, '.mjs')))), child.compiledMain[name], 'Executed Main transform is byte-bound')
      }
    }
    assert.notEqual(result.renderer.phases[0].renderer.pid, result.renderer.phases[1].renderer.pid, 'Fresh process identity must differ')
    result.renderer.passed = true
    await writeFile(join(evidence, 'renderer.json'), JSON.stringify(result.renderer, null, 2))
    result.exit = { exitCode: 0, timedOut: false, phases: result.renderer.phases.map(one => one.exit) }
    result.runtimeMainInputs = Object.fromEntries([...inputs].filter(([file]) => !Object.hasOwn(result.inputs, relative(repository, file))).map(([file, digest]) => [relative(repository, file), digest]))
  } else {
    result.exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'),
    join(outDir, 'index.html'), privateRoot, evidence, ...(selectedFrames ? [JSON.stringify(selectedFrames)] : [])], {
    temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000,
    onLine: line => logs.push(line)
  })
  await writeFile(join(evidence, 'renderer.log'), logs.join('\n'))
  result.renderer = JSON.parse(await readFile(join(evidence, 'renderer.json'), 'utf8'))
  }
  assert.equal(result.exit.timedOut, false, 'The bounded Renderer must publish a result')
  assert.equal(result.exit.exitCode, 0, result.renderer.failure?.message)
  assert.equal(result.renderer.passed, true)
  assert.equal(result.renderer.frames.length, selectedFrames?.length ?? 8, 'Every selected actual frame must be captured')
  if (selectedFrames) assert.deepEqual(result.renderer.frames.map(frame => frame.name), selectedFrames)
  if (motePaperdoll) {
    assert.ok(result.renderer.checks.length > 12, 'Actual face proof has nonempty controls, native animation/cost, failure and durable restoration')
    assert.equal(result.renderer.phases.length, 2)
    assert.ok(result.renderer.phases[0].renderer.dynamic.tool.length >= 3, 'Real intermediate tool frames are nonempty')
    for (const frame of result.renderer.phases[0].renderer.dynamic.tool) assert.equal(hash(await readFile(join(evidence, 'seed', frame.file))), frame.sha256)
  } else if (moteArchive) {
    assert.ok(result.renderer.checks.length >= 10, 'Archive proof has actual controls, original FS, failure and both process results')
    assert.equal(result.renderer.phases.length, 2)
  } else if (moteIdentity) {
    assert.ok(result.renderer.checks.length >= 10, 'Identity proof must include actual controls and real directory/assets')
    assert.equal(result.renderer.reload.passed, true, 'Same-profile choice/asset reload must be proven')
  } else if (floatingResize) {
    assert.ok(result.renderer.checks.length >= 12, 'Actual resize proof must be nonempty and complete')
    assert.equal(result.renderer.replayedFrames.length, selectedFrames.length, 'Only reviewed resize frames replayed')
  } else if (footerOnly) assert.equal(result.renderer.checks.length, 16, 'Every actual Footer count case is retained')
  else assert.equal(result.renderer.replayedFrames.length, 8, 'All original actual interactions and assertions are retained')
  for (const frame of result.renderer.frames) {
    assert.equal(hash(await readFile(join(evidence, frame.file))), frame.sha256, 'Actual frame bytes agree')
  }
  if (footerOnly) {
    const source = join(repository, 'apps/desktop/src/renderer/src/styles/agent.css')
    const css = originalBytes.get(source).toString('utf8')
    const rules = [...css.matchAll(/^  \.window-status-bar \.surface-navigation__focus \{[^\n]+\}/gm)]
    assert.equal(rules.length, 1, 'The actual narrow Focus source rule is unique and nonempty')
    const declarations = 'width: auto; flex-basis: auto; '
    assert.equal(rules[0][0].split(declarations).length - 1, 1)
    const mutatedCss = css.replace(rules[0][0], rules[0][0].replace(declarations, ''))
    assert.notEqual(mutatedCss, css, 'Two actual producer declarations are removed')
    const compiledMatches = []
    for (const file of Object.keys(result.compiled).filter(file => file.endsWith('.css'))) {
      const contents = await readFile(join(outDir, file), 'utf8')
      if (contents.includes(css)) compiledMatches.push({ file, contents, occurrences: contents.split(css).length - 1 })
    }
    assert.equal(compiledMatches.length, 1, 'One compiled stylesheet consumes the entire original CSS source block')
    assert.equal(compiledMatches[0].occurrences, 1, 'The complete source anchor must be unique')
    const changed = compiledMatches[0], mutatedOutput = changed.contents.replace(css, mutatedCss)
    assert.equal(mutatedOutput.replace(mutatedCss, css), changed.contents, 'All bytes outside the exact source mutation are retained')
    const mutatedRoot = join(privateRoot, 'mutated-renderer')
    await cp(outDir, mutatedRoot, { recursive: true })
    await writeFile(join(mutatedRoot, changed.file), mutatedOutput)
    const mutationEvidence = join(evidence, 'mutation'), restoredEvidence = join(evidence, 'restored')
    await mkdir(mutationEvidence); await mkdir(restoredEvidence)
    await writeFile(join(mutationEvidence, 'agent.css'), mutatedCss)
    const replay = async (renderer, destination) => {
      const replayLogs = []
      const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(renderer, 'index.html'),
        privateRoot, destination, JSON.stringify(selectedFrames)], { temporaryRoot: privateRoot, cwd: repository, env,
        timeoutMs: 60000, onLine: line => replayLogs.push(line) })
      await writeFile(join(destination, 'renderer.log'), replayLogs.join('\n'))
      return { exit, renderer: JSON.parse(await readFile(join(destination, 'renderer.json'), 'utf8')) }
    }
    result.stage = 'actual-source-mutation-red'
    const red = await replay(mutatedRoot, mutationEvidence)
    assert.equal(red.exit.timedOut, false); assert.equal(red.exit.exitCode, 1)
    assert.equal(red.renderer.passed, false); assert.equal(red.renderer.failure?.name, 'AssertionError')
    assert.match(red.renderer.failure.message, /Focus (icon|badge|count text) (fits its original button|has positive area)/, 'Only actual count geometry RED proves the mutation')
    result.sourceMutation = { kind: 'exact-whole-source-block-replacement', source: relative(repository, source),
      originalSourceSha256: hash(Buffer.from(css)), mutatedSourceSha256: hash(Buffer.from(mutatedCss)),
      compiledCssFile: changed.file, originalCompiledSha256: hash(Buffer.from(changed.contents)),
      mutatedCompiledSha256: hash(Buffer.from(mutatedOutput)), allOtherCompiledBytesUnchanged: true,
      originalRendererUnchanged: true, sharedSourceUntouched: true, ...red }
    result.stage = 'same-original-source-restored-green'
    result.restored = await replay(outDir, restoredEvidence)
    assert.equal(result.restored.exit.timedOut, false); assert.equal(result.restored.exit.exitCode, 0)
    assert.equal(result.restored.renderer.passed, true); assert.equal(result.restored.renderer.checks.length, 16)
    for (const frame of result.restored.renderer.frames) assert.equal(hash(await readFile(join(restoredEvidence, frame.file))), frame.sha256)
  }
  result.stage = 'source-style-and-compiled-final-binding'
  for (const [file, digest] of inputs) {
    if ((!floatingResize && !moteArchive && !motePaperdoll) || result.candidate.files.some(row => row.path === relative(repository, file)))
      assert.equal(hash(await readFile(file)), digest, `Owned input changed during capture: ${relative(repository, file)}`)
    assert.equal(hash(await readFile(join(result.originalInputs, relative(repository, file)))), digest, 'Archived original bytes agree')
  }
  for (const [name, digest] of Object.entries(result.compiled)) {
    assert.equal(hash(await readFile(join(evidence, 'renderer', name))), digest, 'Archived compilation agrees')
  }
  for (const row of result.candidate?.files ?? []) assert.equal(hash(await readFile(join(repository, row.path))), row.sha256, 'Candidate remains coherent after capture')
  if (floatingResize || moteArchive || motePaperdoll) result.bindingScope = 'All actual compiled/executed inputs and styles are immutable archived bytes. Task-owned candidate/producers remain current; unrelated whole-App end drift is separately reported without changing archived proof.'
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
    result.sourceDrift = true
    if ((!floatingResize && !moteArchive && !motePaperdoll) || result.inputFreshnessAtFinish.changed.some(row => result.candidate?.files.some(owned => owned.path === row.path))) result.passed = false
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
    motePaperdoll ? '# Mote face and truthful expressions — independent actual look pending' : moteArchive ? '# Mote archive and same-object restore — independent actual look pending' : moteIdentity ? '# Mote avatars and primary identity — independent actual look pending' : '# Mote rail / footer / Settings — independent actual look pending', '',
    `Capture passed: ${result.passed}. Stage: ${result.stage}. This is ${moteArchive || motePaperdoll ? 'one private Renderer compilation consumed by two private processes' : 'a single private Renderer capture'}, not native/OS/Core Run sign-off.`, '',
    ...(result.renderer?.frames ?? []).map(frame => `- ${frame.name}: [Actual complete Renderer frame](${frame.file}) — ${frame.sha256}`), '',
    motePaperdoll ? 'Open all six full frames and original native-animation intermediate frames. Review original dragon/image, compact real face editor, saved thinking/tool face, narrow Idle, new-process sleep, unknown and actionable save failure. React profiling commit evidence concerns actual product face consumers, while original App events still update. No Core Run or user App recovery claim.' : moteArchive ? 'Open all five complete frames. Review actual Archive menu inside the native HTML popover, wide cards/narrow avatars, selected archived original input with Restore, Space Show archived/same-object recovery, and compact actionable failure/unknown notice. Fresh-process original tabs/layout/drafts and actual FS readback are in seed/restore receipts. No old matrix, healthy Core Run or native-stage claim.' : moteIdentity ? 'Open all six complete frames. Review the same primary/custom images at 980/420 in cards/avatars, the original circle crop and actionable saving-unconfirmed dialog, visible primary identity, retained real input and same full Space identity. Current Source owners and real private filesystem asset proof are bounded in renderer.json; no healthy App/Core Run claim.' : floatingResize ? 'Open all five complete frames. Review actual corner handle discoverability/hit area, 10px top/right frame, wide/narrow card/avatar original workface, advisory storage failure and usable original input. Only floating resize scope is new.' : footerOnly ? 'Open all five complete frames. Review actual nonzero Focus counts and neighbors at 320/420/560/980, dark/light 320, complete low bar/Mote circle and right-side actions. Only the Footer count supplement is new.' :
      'Open every frame. Review both rail forms, complete objects and original input, narrow long names, dark/light boundary, low bar and complete circle/status/focus, and Settings operability.',
    'Original inputs/raw CSS/compiled bytes and actual geometry/events are in receipt.json. Capture success does not constitute aesthetic approval.'
  ].join('\n'))
}
console.log(JSON.stringify({ passed: result.passed, stage: result.stage,
  receipt: join(evidence, 'receipt.json'), compiled: result.compiledRenderer, cleanup: result.cleanup, failure: result.failure }))
assert.equal(result.cleanup.remaining.length, 0, 'Preserve unconfirmed private process roots')
assert.equal(result.cleanup.privateRootRemoved, true)
assert.equal(result.passed, true, result.failure?.message)
