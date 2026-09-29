import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'

export async function verifyBrowserSettingsNative() {
  const repository = resolve(import.meta.dirname, '../../../../..'), desktop = join(repository, 'apps/desktop')
  const acceptedPath = process.env.AGENTMUX_BROWSER_SETTINGS_NATIVE_RECEIPT
  if (acceptedPath) {
    const reviewPath = process.env.AGENTMUX_BROWSER_SETTINGS_VISUAL_REVIEW
    assert.ok(reviewPath, 'A sealed native receipt requires its independent actual image review')
    const receiptPath = resolve(acceptedPath), sourceEvidence = resolve(receiptPath, '..')
    const bytes = await readFile(receiptPath), accepted = JSON.parse(bytes)
    const digest = value => createHash('sha256').update(value).digest('hex')
    const reviewBytes = await readFile(resolve(reviewPath)), review = JSON.parse(reviewBytes)
    assert.equal(accepted.schema, 'agentmux.focus-browser-settings-native.v1')
    assert.equal(accepted.capturedPass, true, 'Actual original private native capture passed')
    assert.equal(accepted.failure, undefined)
    assert.equal(accepted.native.passed, true)
    assert.equal(accepted.process.exitCode, 0, 'Original private native process exited successfully')
    assert.equal(accepted.cleanup.removed, true)
    assert.deepEqual(accepted.cleanup.remaining, [])
    assert.equal(accepted.userAppRunRuntimeControlled, false)
    assert.deepEqual(accepted.sourceAfter, accepted.inputs, 'Original capture Source did not change')
    assert.equal(review.verdict, 'pass')
    assert.equal(review.nativeReceiptSHA256, digest(bytes), 'Independent review binds this exact original receipt')
    assert.deepEqual(review.sourceBinding, accepted.inputs)
    assert.deepEqual(JSON.parse(await readFile(join(sourceEvidence, 'native-receipt.json'), 'utf8')), accepted.native,
      'Original native facts remain identical to the sealed wrapper')
    assert.ok(Object.keys(accepted.inputs).length > 0, 'Nonempty compiled Source binding')
    const sourceCurrent = Object.fromEntries(await Promise.all(Object.entries(accepted.inputs).map(async ([path]) =>
      [path, digest(await readFile(join(repository, path)))])))
    assert.deepEqual(sourceCurrent, accepted.inputs, 'Current actual consumed Source equals the reviewed native capture')
    assert.deepEqual(accepted.native.phases.map(phase => phase.width), [960, 640], 'Both actual viewports are present')
    assert.equal(accepted.frames.length, 6, 'Three actual frames in each viewport')
    assert.equal(review.viewedImages.length, accepted.frames.length)
    for (const phase of accepted.native.phases) {
      assert.equal(phase.control.hit, true)
      assert.equal(phase.control.nonempty, true)
      assert.equal(phase.settings.hit, true, 'Original Settings overlay actually accepts the center hit')
      assert.equal(phase.settings.nonempty, true)
      assert.equal(phase.settings.originalOverlayClasses, true)
      assert.equal(phase.foregroundInput.passed, true, 'Other-Tab foreground native input remains qualified')
      assert.equal(phase.hiddenAndReturnedSameId, phase.original.webContentsId)
      assert.deepEqual(phase.pageAfter, phase.pageBefore, 'Original same-viewport page input/selection/scroll remain')
      for (const key of ['sameStage', 'sameHost', 'sameParent', 'sameTabs', 'sameLayouts', 'sameSessions', 'sameDrafts'])
        assert.equal(phase.facts[key], true, key)
    }
    for (const frame of accepted.frames) {
      const imageBytes = await readFile(join(sourceEvidence, frame.file))
      assert.ok(imageBytes.length > 0, 'Actual captured PNG is nonempty')
      assert.equal(digest(imageBytes), frame.sha256, 'Original PNG has not changed')
      const viewed = review.viewedImages.find(image => image.file === frame.file)
      assert.ok(viewed && viewed.sha256 === frame.sha256 && viewed.observation?.length > 0,
        'Independent actual observation of ' + frame.file)
    }
    const evidence = join(repository, '.tmp', `focus-browser-settings-visibility-native-acceptance-${Date.now()}`)
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify({
      schema: 'agentmux.focus-browser-settings-native-acceptance.v1', passed: true,
      originalNativeReceipt: { path: receiptPath, sha256: digest(bytes) },
      independentVisualReview: { path: resolve(reviewPath), sha256: digest(reviewBytes) },
      sourceCurrent, frames: accepted.frames, cleanup: accepted.cleanup,
      qualification: 'Exact sealed actual native facts/PNGs and independently reviewed Source are consumed; no new App, build, Runtime or capture. The original pending-review receipt is preserved unchanged.',
      limitations: accepted.limitations, userAppRunRuntimeControlled: false
    }, null, 2) + '\n')
    console.log(JSON.stringify({ evidence: relative(repository, evidence), passed: true, sealedNativeFactsConsumed: true }))
    return
  }
  const require = createRequire(join(desktop, 'package.json'))
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const fixture = import.meta.dirname, mature = join(desktop, 'scripts/fixtures/mote-shortcut')
  const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-browser-settings-'))
  const evidence = process.env.AGENTMUX_BROWSER_SETTINGS_NATIVE_EVIDENCE
    ? resolve(process.env.AGENTMUX_BROWSER_SETTINGS_NATIVE_EVIDENCE)
    : join(repository, '.tmp', `focus-browser-settings-visibility-native-${Date.now()}`)
  await mkdir(evidence, { recursive: true })
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const inputs = new Map(), transformations = [], logs = []
  const receipt = { schema: 'agentmux.focus-browser-settings-native.v1', passed: false, capturedPass: false,
    captureOnly: true, aestheticReview: 'not-performed', evidence, userAppRunRuntimeControlled: false,
    limitations: [
      'A bounded compiled App fixture isolates only Focus destination, PTY/Agent painting and Settings content. App route/SurfaceSwitch/Workspace/Stable/BrowserPane, their real desktop bounds owner and the existing native Browser manager remain actual product.',
      'The sole API export selects the maintained typed factory for non-Browser controlled facts; native Browser/UI use the mature sandboxed private bridge with exact WebContents/mainFrame checks. No main public ABI, original product source or Core/Runtime is changed.',
      'Renderer and original native page images are separate WebContents captures, never an OS composition. Trusted CDP input is not physical mouse/OS focus qualification. Controlled Session/Run references do not certify real healthy Runs.',
      'The current same-entity simultaneous native multi-binding engine is outside this existing other-Tab Mote/local Settings proof.'
    ] }
  const observe = { name: 'bound-original-source-and-narrow-leaf-isolation', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(repository + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, digest(source))
      const component = path.slice(path.lastIndexOf('/') + 1)
      if (component === 'GlobalFocusSurface.tsx') {
        transformations.push({ path: relative(repository, path), isolated: 'Focus destination only' })
        return { contents: `import {createElement as h} from 'react';export function GlobalFocusSurface(){return h('div',{style:{height:'100%',display:'flex',minHeight:0}},h('div',{id:'focus-workspace-slot',style:{flex:1,minHeight:0}}))}`, loader: 'js' }
      }
      if (component === 'SessionPane.tsx') {
        transformations.push({ path: relative(repository, path), isolated: 'PTY/Agent paint only' })
        return { contents: `import {createElement as h} from 'react';export function SessionPane({sessionId}){return h('div',{'data-controlled-session':sessionId,style:{padding:'20px'}},'Original Session reference retained')}`, loader: 'js' }
      }
      if (component === 'EditorPane.tsx' || component === 'GitBranchDiffPane.tsx') {
        transformations.push({ path: relative(repository, path), isolated: 'Unused adjacent Monaco leaf; no file/editor Region exists in this scene' })
        return { contents: `export function ${component.slice(0, -4)}(){return null}`, loader: 'js' }
      }
      if (component === 'SettingsPanel.tsx') {
        transformations.push({ path: relative(repository, path), isolated: 'Settings content only; original settings-page/settings-content overlay classes retained' })
        return { contents: `import {createElement as h} from 'react';export function SettingsPanel({onClose}){return h('div',{className:'settings-page','data-fixture-settings':true},h('div',{className:'window-drag-region'}),h('aside',{className:'settings-sidebar'},h('div',{className:'settings-sidebar__brand'},h('strong',null,'Settings'))),h('main',{className:'settings-content'},h('header',{className:'settings-content__header'},h('div',{className:'settings-content__title'},h('h2',null,'Settings')),h('button',{className:'settings-content__close icon-button','aria-label':'Close settings',onClick:onClose},'×')),h('section',{className:'settings-content__scroll'},h('p',null,'The background Browser is hidden. Its original Tab and page remain available.'),h('p',null,'Use the original Settings control below to return.'))))}`, loader: 'js' }
      }
      if (path === join(desktop, 'src/renderer/src/lib/api.ts')) {
        const anchor = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
        assert.equal(source.split(anchor).length - 1, 1)
        const code = source.replace(anchor, 'export const api = mockApi')
        transformations.push({ path: relative(repository, path), controlledApiExportOnly: true, originalSHA256: digest(source), consumedSHA256: digest(code) })
        return { contents: code, loader: 'ts' }
      }
      return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      if (!path.startsWith(repository + '/') || path.includes('/node_modules/')) return
      const contents = await readFile(path, 'utf8'); inputs.set(path, digest(contents))
      return { contents, loader: 'css' }
    })
  } }
  try {
    for (const file of ['main.cjs', 'entry.mjs', 'native-proof.mjs']) inputs.set(join(fixture, file), digest(await readFile(join(fixture, file))))
    for (const file of ['preload.cjs', 'browser.html']) inputs.set(join(mature, file), digest(await readFile(join(mature, file))))
    const output = join(privateRoot, 'out'); await mkdir(output)
    const nativeBundle = join(output, 'native.mjs'), rendererBundle = join(output, 'app.js')
    const nativeBuild = await build({ entryPoints: [join(mature, 'native-browser.ts')], outfile: nativeBundle, bundle: true,
      platform: 'node', format: 'esm', packages: 'bundle', target: 'node22', external: ['electron'], metafile: true, plugins: [observe], logLevel: 'silent',
      banner: { js: "import {createRequire as createNativeRequire} from 'node:module';const require=createNativeRequire(import.meta.url);" } })
    const rendererBuild = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: rendererBundle, bundle: true,
      platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
      define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
      loader: { '.png': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
    receipt.metafiles = { native: nativeBuild.metafile, renderer: rendererBuild.metafile }
    receipt.inputs = Object.fromEntries([...inputs].map(([file, hash]) => [relative(repository, file), hash]))
    receipt.transformations = transformations
    for (const suffix of ['App.tsx', 'WorkspaceWorkbench.tsx', 'StableWorkbenchView.tsx', 'BrowserPane.tsx', 'browser-view-manager.ts', 'browser-bounds-sync.ts']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Actual compiled owner ' + suffix)
    const html = join(output, 'index.html')
    await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
    receipt.compiled = { native: digest(await readFile(nativeBundle)), renderer: digest(await readFile(rendererBundle)), css: digest(await readFile(join(output, 'app.css'))) }
    const env = { ...process.env, HOME: join(privateRoot, 'home'), AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'),
      AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence,
      nativeBundle, join(mature, 'preload.cjs'), join(mature, 'browser.html')], { temporaryRoot: privateRoot, cwd: repository, env,
      timeoutMs: 75_000, onLine: line => logs.push(line) })
    receipt.process = run; assert.equal(run.exitCode, 0, 'Private native proof actual exit0')
    receipt.native = JSON.parse(await readFile(join(evidence, 'native-receipt.json'), 'utf8'))
    assert.equal(receipt.native.passed, true)
    receipt.frames = []
    for (const frame of receipt.native.frames) receipt.frames.push({ ...frame, sha256: digest(await readFile(join(evidence, frame.file))) })
    receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async file => [relative(repository, file), digest(await readFile(file))])))
    assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Exact consumed Source stable through private proof')
    receipt.capturedPass = true
    const reviewPath = process.env.AGENTMUX_BROWSER_SETTINGS_VISUAL_REVIEW
    if (reviewPath) {
      const review = JSON.parse(await readFile(resolve(reviewPath), 'utf8'))
      assert.equal(review.verdict, 'pass')
      assert.deepEqual(review.sourceBinding, receipt.inputs)
      assert.equal(review.viewedImages.length, receipt.frames.length)
      for (const frame of receipt.frames) assert.ok(review.viewedImages.some(image => image.file === frame.file && image.sha256 === frame.sha256), 'Independent actual image review ' + frame.file)
      receipt.independentVisualReview = { path: resolve(reviewPath), sha256: digest(await readFile(resolve(reviewPath))) }
      receipt.aestheticReview = 'independent-pass'; receipt.captureOnly = false; receipt.passed = true
    } else receipt.pendingIndependentVisualReview = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    await writeFile(join(evidence, 'process.log'), logs.join('\n'))
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.cleanup = { remaining, privateRoot, removed: false, evidencePreserved: true }
    if (remaining.length === 0) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify({ evidence: relative(repository, evidence), capturedPass: receipt.capturedPass, passed: receipt.passed, failure: receipt.failure?.message, pendingIndependentVisualReview: receipt.pendingIndependentVisualReview }))
    if (!receipt.passed) process.exitCode = 1
  }
}
