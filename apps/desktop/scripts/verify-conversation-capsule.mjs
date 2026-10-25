import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { aliases, installedDependency } from './fixtures/conversation-style-entry/environment.mjs'
const presentationOnly = process.argv.includes('--presentation-only')
assert.ok(process.argv.slice(2).every(argument => argument === '--presentation-only'), 'Unknown Capsule verification scope')
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: bundle } = createRequire(require.resolve('vite/package.json'))('esbuild')
const fixture = join(desktop, 'scripts/fixtures/conversation-capsule')
const formalStyles = 'apps/desktop/src/renderer/src/styles/index.css'
const capsuleStyles = 'packages/client-ui/src/styles/conversation-capsule.css', diagramStyles = 'packages/client-ui/src/styles/diagram-image.css'
const rendererSources = ['packages/client-ui/src/components/AgentMarkdown.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx',
  'apps/desktop/src/renderer/src/components/ConversationCapsule.tsx', 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx',
  'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts', 'apps/desktop/src/renderer/src/lib/browser-stage-geometry.ts',
  'apps/desktop/src/renderer/src/components/CapsuleInteractionChrome.tsx', 'apps/desktop/src/renderer/src/components/CapsuleQuestionReply.tsx',
  'apps/desktop/src/renderer/src/lib/capsule-question-editors.tsx', 'packages/client-ui/src/components/DiagramImage.tsx',
  'packages/client-ui/src/components/ConversationImageViewport.tsx', 'apps/desktop/src/renderer/src/components/ServiceWindowNotice.tsx',
  'apps/desktop/src/renderer/src/components/ServiceNoticeDisclosure.tsx', 'apps/desktop/src/renderer/src/lib/use-service-notices.ts',
  'apps/desktop/scripts/fixtures/conversation-style-entry/notice-receipts.ts',
  'apps/desktop/src/renderer/src/components/ConversationAxis.tsx', 'apps/desktop/src/renderer/src/components/ConversationRuler.tsx',
  'apps/desktop/src/renderer/src/components/ConversationReadingRuler.tsx', 'apps/desktop/src/renderer/src/lib/use-conversation-keyframes.ts',
  'apps/desktop/scripts/fixtures/conversation-capsule/unused-avatar.ts']
const nativeSources = ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/capsule-presentation.ts',
  'apps/desktop/src/main/capsule-document-ipc.ts', 'apps/desktop/src/main/workbench-windows.ts', 'apps/desktop/src/main/workbench-window-store.ts']
const allSources = ['packages/client-ui/src/components/AgentMarkdown.tsx', 'packages/client-ui/src/platform.tsx',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'apps/desktop/src/renderer/src/components/ConversationCapsule.tsx',
  'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx', 'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts',
  'apps/desktop/src/renderer/src/lib/browser-stage-geometry.ts', 'packages/client-ui/src/styles/conversation-capsule.css',
  'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/capsule-presentation.ts',
  'packages/client-ui/src/components/ConversationInputText.tsx', 'packages/client-ui/src/components/ConversationResourceText.tsx',
  'apps/desktop/src/renderer/src/lib/workbench-document.tsx', 'apps/desktop/src/main/workbench-windows.ts', 'apps/desktop/src/main/workbench-window-store.ts',
  'apps/desktop/src/renderer/src/components/ConversationReadingRuler.tsx', 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx', 'apps/desktop/src/renderer/src/lib/use-conversation-keyframes.ts',
  'apps/desktop/src/renderer/src/components/CapsuleInteractionChrome.tsx', 'apps/desktop/src/renderer/src/components/CapsuleQuestionReply.tsx',
  'apps/desktop/src/renderer/src/lib/capsule-question-editors.tsx',
  formalStyles, diagramStyles, 'apps/desktop/src/renderer/src/styles/capsule-interaction.css', 'apps/desktop/src/renderer/src/styles/browser.css',
  'packages/client-ui/src/components/DiagramImage.tsx', 'packages/client-ui/src/components/ConversationImageViewport.tsx',
  'packages/client-ui/src/styles/conversation-image.css', 'apps/desktop/src/renderer/src/main.tsx',
  'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs',
  'apps/desktop/src/shared/contracts.ts', 'packages/core/guides/modules/capsule.md', 'packages/core/src/generated/agentmux-guides.ts',
  'apps/desktop/test/conversation-capsule.test.tsx', 'apps/desktop/test/conversation-capsule.config.mts',
  'apps/desktop/test/capsule-chrome.test.tsx', 'apps/desktop/test/capsule-partial-recovery.test.tsx',
  ...['entry.tsx', 'main.ts', 'api.ts', 'preload.cjs', 'bootstrap.cjs', 'index.html'].map(name => `apps/desktop/scripts/fixtures/conversation-capsule/${name}`),
  'apps/desktop/scripts/verify-conversation-capsule.mjs',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/main/ipc.ts']
const sources = [...new Set([...allSources.filter(path => !presentationOnly || ![
  'apps/desktop/src/shared/contracts.ts', 'packages/core/guides/modules/capsule.md', 'packages/core/src/generated/agentmux-guides.ts',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/main/ipc.ts'].includes(path)),
  ...rendererSources, ...nativeSources, 'apps/desktop/scripts/fixtures/conversation-style-entry/build-renderer.mjs',
  'apps/desktop/scripts/fixtures/conversation-style-entry/environment.mjs'])]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
// Vite loads CSS @imports inside PostCSS, bypassing Rollup transform for those files.
// Bind the inputs actually present in its expanded AST, rather than importing them again.
const boundStyles = (loaded, expectedFormal) => ({ postcssPlugin: 'exact-formal-conversation-css-inputs', Once(sheet) {
  sheet.walk(node => {
    const input = node.source?.input
    if (!input?.file) return
    const path = relative(root, input.file)
    if (!sources.includes(path) || loaded.includes(path)) return
    assert.equal(hash(input.css), path === formalStyles ? hash(expectedFormal()) : hashes[path], `${path}: the formal CSS graph must read the exact candidate`)
    loaded.push(path)
  })
} })
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp/capsule-embed-private-'))
const evidence = await mkdtemp(join(root, '.tmp/capsule-embed-evidence-'))
const report = { passed: false, scope: presentationOnly ? 'presentation' : 'full', sources: hashes, evidence, phases: [], cssBuilds: [],
  boundary: 'Private Electron: real shared ConversationMessage/AgentMarkdown, production ConversationCapsule/native Stage, actual BrowserViewManager, original Capsule acquisition helper and NodeCapsuleOwner HTTP/SDK. Only fixture transport and body placement substitute Desktop IPC/Workbench. Installed product, full spatial restoration and user Runs are outside this receipt.' }
let nativeStarted = false
try {
  const vitest = join(dirname(createRequire(join(root, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs')
  const unitLines = []
  const unit = await runProbeProcess(process.execPath, [vitest, 'run', '--config', 'apps/desktop/test/conversation-capsule.config.mts', '--configLoader', 'runner', '--reporter=dot'],
    { cwd: root, env: process.env, timeoutMs: 180000, onLine: line => unitLines.push(line) })
  await writeFile(join(evidence, 'unit.log'), unitLines.join('\n'))
  report.unit = unit
  assert.equal(unit.exitCode, 0, 'The exact owning consumer/native suites must pass')
  if (!presentationOnly) {
  const providerPath = 'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', ipcPath = 'apps/desktop/src/main/ipc.ts'
  const provider = await readFile(join(root, providerPath), 'utf8'), ipc = await readFile(join(root, ipcPath), 'utf8')
  assert.ok(provider.includes('renderCapsuleEmbed: input => <ConversationCapsule'), 'The actual Desktop platform must instantiate this Capsule consumer')
  assert.ok(ipc.includes('return await createCapsuleBrowserDocument('), 'The actual Main IPC must consume the exact original acquisition helper')
  assert.ok(ipc.includes('args.workbenchWindows.windowForDocument(document)'), 'Inline native display must use the original native document owner')
  report.consumers = { provider: hashes[providerPath], ipc: hashes[ipcPath] }
  }
  assert.match(await readFile(join(root, 'apps/desktop/src/renderer/src/main.tsx'), 'utf8'), /import ['"]\.\/styles\/index\.css['"]/, 'The formal Renderer must consume the stylesheet entry under proof')
  const entry = await readFile(join(fixture, 'entry.tsx'), 'utf8')
  assert.deepEqual([...entry.matchAll(/^import ['"]([^'"]+\.css)['"]/gm)].map(match => match[1]), ['../../../src/renderer/src/styles/index.css'], 'The fixture must consume only the formal Renderer stylesheet, without private CSS repairs')
  await mkdir(join(temporary, 'preload'), { recursive: true }); await mkdir(join(temporary, 'main'), { recursive: true })
  await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'), 'dir')
  if (!presentationOnly) {
  const guideModule = join(temporary, 'module-skills.mjs')
  await writeFile(guideModule, `import {registerHooks} from 'node:module';import {existsSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){const candidate=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(fileURLToPath(candidate)))return next(candidate.href,context)}throw error}}});
const {agentMuxModuleSkill}=await import(${JSON.stringify(pathToFileURL(join(root, 'packages/core/src/agentmux-cli-module-skills.ts')).href)});writeFileSync(process.argv[2],agentMuxModuleSkill('capsule'));`)
  const guideRead = await runProbeProcess(process.execPath, ['--experimental-transform-types', guideModule, join(evidence, 'capsule-skill.txt')], { cwd: root, env: process.env, timeoutMs: 30000 })
  assert.equal(guideRead.exitCode, 0, 'The original module-skill composition must execute')
  const guide = await readFile(join(evidence, 'capsule-skill.txt'), 'utf8')
  assert.ok(guide.includes('![Page title](amux://capsule/ORIGINAL_ID)') && guide.includes('already-serving') && guide.includes('auto-Close'))
  await writeFile(join(evidence, 'capsule-skill.txt'), guide)
  report.guideConsumer = 'agentMuxModuleSkill(capsule), the original amux MODULE --skill composition function'
  }
  await bundle({ entryPoints: [join(desktop, 'src/preload/capsule.ts')], outfile: join(temporary, 'preload/capsule.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
  const cssProof = []
  for (const mode of ['green', 'without-capsule', 'without-diagram', 'restored']) {
    const loaded = [], original = await readFile(join(root, formalStyles), 'utf8')
    let transformed = original
    const result = await build({ configFile: false, root: desktop, base: './', logLevel: 'error', resolve: { alias: aliases }, css: { postcss: { plugins: [boundStyles(loaded, () => transformed)] } },
      plugins: [{ name: `formal-conversation-css-${mode}`, enforce: 'pre', transform(code, id) {
        const path = relative(root, id.split('?')[0])
        if (sources.includes(path)) { assert.equal(hash(code), hashes[path]); loaded.push(path) }
        if (path !== formalStyles) return null
        const target = mode === 'without-capsule' ? 'conversation-capsule' : mode === 'without-diagram' ? 'diagram-image' : null
        if (!target) return null
        const pattern = new RegExp(`^@import ['"]@agentmux/client-ui/styles/${target}\\.css['"];\\r?\\n?`, 'gm')
        assert.equal([...code.matchAll(pattern)].length, 1, 'The CSS mutation must reach one exact formal stylesheet import')
        transformed = code.replace(pattern, '')
        return transformed
      } }], build: { write: false, minify: false, cssMinify: false, rollupOptions: { input: join(root, formalStyles) } } })
    const output = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
    const css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n')
    assert.ok(css.length > 1000, 'The actual formal CSS graph must compile to a nonempty stylesheet')
    assert.equal(loaded.includes(capsuleStyles), mode !== 'without-capsule', 'Only the exact formal Capsule import may supply its rules')
    assert.equal(loaded.includes(diagramStyles), mode !== 'without-diagram', 'Only the exact formal diagram import may supply its rules')
    const binding = { mode, sourceSHA256: hash(original), loadedSHA256: hash(transformed), cssSHA256: hash(css), loaded }
    report.cssBuilds.push(binding); cssProof.push({ ...binding, css })
  }
  assert.equal(cssProof[0].cssSHA256, cssProof.at(-1).cssSHA256, 'Restoring the untouched formal entry must restore its exact compiled stylesheet')
  const cssProofPath = join(temporary, 'formal-css-proof.json'); await writeFile(cssProofPath, JSON.stringify(cssProof))
  await writeFile(join(temporary, 'renderer-inputs.json'), JSON.stringify(Object.fromEntries(rendererSources.map(path => [path, hashes[path]]))))
  const rendererLines = []
  report.rendererBuild = await runProbeProcess(process.execPath, [join(desktop, 'scripts/fixtures/conversation-style-entry/build-renderer.mjs'),
    join(temporary, 'renderer'), join(temporary, 'renderer-inputs.json'), join(temporary, 'renderer-receipt.json'), fixture, join(fixture, 'unused-avatar.ts')],
    { cwd: root, env: process.env, timeoutMs: 180000, onLine: line => rendererLines.push(line) })
  await writeFile(join(evidence, 'renderer-build.log'), rendererLines.join('\n'))
  assert.equal(report.rendererBuild.exitCode, 0, 'The owned Renderer build must complete before native acquisition')
  const rendererReceipt = JSON.parse(await readFile(join(temporary, 'renderer-receipt.json'), 'utf8'))
  report.rendererLoaded = rendererReceipt.loaded; report.rendererStoreIO = rendererReceipt.storeIO; report.avatarBoundary = rendererReceipt.avatarBoundary
  assert.equal(report.avatarBoundary?.importer, 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx')
  for (const path of rendererSources) assert.ok(report.rendererLoaded.includes(path), `The production Renderer must actually compile ${path}`)
  for (const phase of presentationOnly ? ['green'] : ['green', 'clipped-input-mutant', 'restored']) {
    let mutated = 0
    const nativeLoaded = new Set()
    const native = join(temporary, 'main', `${phase}.mjs`)
    await bundle({ entryPoints: [join(fixture, 'main.ts')], outfile: native, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'error',
      plugins: [{ name: 'native-input-geometry-mutation', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\/(?:host|client-ui)(?:\/|$)/ }, ({ path }) => {
          const alias = aliases.find(alias => alias.find.test(path))
          return alias ? { path: path.replace(alias.find, alias.replacement) } : undefined
        })
        builder.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
          if (path === 'electron') return
          const installed = installedDependency(path, importer)
          return installed ? { path: installed, external: true } : undefined
        })
        builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
          const sourcePath = relative(root, path)
          if (!nativeSources.includes(sourcePath)) return
          const bytes = await readFile(path); assert.equal(hash(bytes), hashes[sourcePath]); nativeLoaded.add(sourcePath)
          if (!path.endsWith('/browser-view-manager.ts')) return
          const source = await readFile(path, 'utf8'); assert.equal(hash(source), hashes['apps/desktop/src/main/browser-view-manager.ts'])
          let contents = source
          if (phase === 'clipped-input-mutant') {
            const anchor = 'if (lease.geometry.visible && lease.geometry.inputVisible !== false) this.setBounds(lease.entry.id, lease.geometry.bounds)'
            assert.equal(source.split(anchor).length - 1, 1)
            contents = source.replace(anchor, 'if (lease.geometry.visible) this.setBounds(lease.entry.id, lease.geometry.bounds)'); mutated++
          }
          return { contents, loader: 'ts', resolveDir: dirname(path) }
        })
      } }] })
    for (const path of nativeSources) assert.ok(nativeLoaded.has(path), `The original native owner must compile ${path}`)
    const profile = join(temporary, `profile-${phase}`)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
    // Electron userData and the Capsule owner already use the private profile; keep caller HOME intact.
    environment.TMPDIR = temporary
    const lines = []
    nativeStarted = true
    const execution = await runProbeProcess(require('electron'), [join(fixture, 'bootstrap.cjs'), native, join(temporary, 'renderer/index.html'), profile, evidence, join(fixture, 'preload.cjs'), phase, cssProofPath, presentationOnly ? 'presentation' : 'full'],
      { cwd: root, env: environment, timeoutMs: 120000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, `${phase}.log`), lines.join('\n'))
    report.currentNativeExecution = execution
    const nativeReport = JSON.parse(await readFile(join(evidence, `${phase}.native.json`), 'utf8'))
    report.phases.push({ phase, execution, mutated, nativeLoaded: [...nativeLoaded], nativeReport })
    if (phase === 'clipped-input-mutant') {
      assert.equal(mutated, 1); assert.notEqual(execution.exitCode, 0)
      assert.equal(nativeReport.failure?.name, 'AssertionError')
      assert.match(nativeReport.failure?.message ?? '', /clipped card cannot cover adjacent conversation content/)
    } else { assert.equal(execution.exitCode, 0, nativeReport.failure?.message); assert.equal(nativeReport.passed, true) }
    if (phase === 'green') assert.equal(nativeReport.cssProof?.phases.length, 4, 'The two missing-import counterexamples must both run in Chromium and restore')
    if (presentationOnly) {
      assert.equal(nativeReport.scope, 'presentation'); assert.equal(nativeReport.activations.length, 0)
      assert.ok(nativeReport.windowFocus.length > 0); for (const value of nativeReport.windowFocus) { assert.equal(value.focused, false); assert.equal(value.visible, false) }
    }
    assert.equal(nativeReport.remainingWindows, 0)
    await rm(profile, { recursive: true, force: true })
  }
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  try {
    for (const pid of nativeStarted ? await listProbeProcesses(-1, temporary) : []) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
    report.remainingProcesses = nativeStarted ? await listProbeProcesses(-1, temporary) : []
    if (report.remainingProcesses.length) report.passed = false
    else if (report.passed || !nativeStarted) await rm(temporary, { recursive: true, force: true })
    else report.retainedFailureBuild = temporary
  } catch (error) { report.passed = false; report.cleanupFailure = { message: error.message, retained: temporary } }
  for (const [path, expected] of Object.entries(hashes)) if (hash(await readFile(join(root, path))) !== expected) { report.passed = false; report.failure ??= { name: 'CandidateDrift', message: path } }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null }))
  process.exitCode = report.passed ? 0 : 1
}
