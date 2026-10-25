import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { aliases, root, desktopRequire, installedDependency } from './fixtures/conversation-style-entry/environment.mjs'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
const { build: bundle } = createRequire(desktopRequire.resolve('vite/package.json'))('esbuild')
const desktop = join(root, 'apps/desktop'), fixture = join(desktop, 'scripts/fixtures/conversation-style-entry')
const formal = 'apps/desktop/src/renderer/src/styles/index.css'
const capsuleCSS = 'packages/client-ui/src/styles/conversation-capsule.css', diagramCSS = 'packages/client-ui/src/styles/diagram-image.css'
const rendererSources = ['packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/AgentMarkdown.tsx',
  'packages/client-ui/src/components/DiagramImage.tsx', 'packages/client-ui/src/components/ConversationImageViewport.tsx',
  'apps/desktop/src/renderer/src/components/ConversationCapsule.tsx', 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx',
  'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts', 'apps/desktop/src/renderer/src/lib/browser-stage-geometry.ts',
  'apps/desktop/src/renderer/src/components/ServiceWindowNotice.tsx', 'apps/desktop/src/renderer/src/components/ServiceNoticeDisclosure.tsx',
  'apps/desktop/src/renderer/src/lib/use-service-notices.ts',
  'apps/desktop/scripts/fixtures/conversation-style-entry/notice-receipts.ts']
const nativeSources = ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/capsule-presentation.ts',
  'apps/desktop/src/main/workbench-windows.ts', 'apps/desktop/src/main/workbench-window-store.ts']
const reused = ['apps/desktop/scripts/fixtures/conversation-capsule/preload.cjs', 'apps/desktop/scripts/fixtures/conversation-capsule/bootstrap.cjs',
  'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs', 'apps/desktop/scripts/probe-process.mjs']
const files = [formal, capsuleCSS, diagramCSS, ...rendererSources, ...nativeSources, ...reused,
  'apps/desktop/src/renderer/src/main.tsx', 'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/main/ipc.ts',
  'apps/desktop/scripts/verify-conversation-style-entry.mjs', ...(await readdir(fixture)).map(file => `apps/desktop/scripts/fixtures/conversation-style-entry/${file}`)]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
const candidateHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp/conversation-style-build-')), evidence = await mkdtemp(join(root, '.tmp/conversation-style-entry-'))
const report = { passed: false, evidence, candidateHead, sourceHashes: hashes, cssPhases: [],
  boundary: 'Formal Desktop stylesheet integration only. Clean Worktree production Capsule and Diagram components/CSS, actual Capsule HTTP/native preview, and original shared image viewer. Original notice components/hook retain their selectors and subscriptions; only the exact final Store edge uses a private Zustand noticeReadReceipts UI acknowledgement port. Every other Store key/action/importer fails. No native activation, user Browser/Run/Session, service recovery, SDK answers, or original diagram engines are exercised.' }
try {
  const entry = await readFile(join(fixture, 'entry.tsx'), 'utf8')
  assert.deepEqual([...entry.matchAll(/^import ['"]([^'"]+\.css)['"]/gm)].map(match => match[1]), ['../../../src/renderer/src/styles/index.css'])
  assert.match(await readFile(join(root, 'apps/desktop/src/renderer/src/main.tsx'), 'utf8'), /import ['"]\.\/styles\/index\.css['"]/)
  const original = await readFile(join(root, formal), 'utf8')
  const cssProof = []
  for (const mode of ['green', 'without-capsule', 'without-diagram', 'restored']) {
    const omit = mode === 'without-capsule' ? capsuleCSS : mode === 'without-diagram' ? diagramCSS : null
    let actual = original
    if (omit) {
      const anchor = `@import '@agentmux/client-ui/styles/${omit.split('/').at(-1)}';`
      assert.equal(original.split(anchor).length, 2, 'The missing-import mutation must reach one exact formal declaration')
      actual = original.replace(anchor, '')
    }
    const loaded = new Set(), outDir = join(temporary, 'css-' + mode)
    const result = await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases },
      plugins: [{ name: 'exact-formal-style-counterexample', enforce: 'pre', transform(code, id) {
        if (relative(root, id.split('?')[0]) !== formal) return null
        assert.equal(hash(code), hashes[formal]); return actual
      } }], css: { postcss: { plugins: [{ postcssPlugin: 'formal-style-input-receipt', Once(sheet) {
        sheet.walk(node => { const input = node.source?.input, file = input?.file && relative(root, input.file)
          if (![formal, capsuleCSS, diagramCSS].includes(file)) return
          assert.equal(hash(input.css), file === formal ? hash(actual) : hashes[file]); loaded.add(file)
        })
      } }] } }, build: { outDir, emptyOutDir: true, rollupOptions: { input: join(root, formal) } } })
    const output = (Array.isArray(result) ? result[0] : result).output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    assert.equal(output.length, 1, 'The formal entry must compile a complete stylesheet')
    assert.ok(loaded.has(formal)); for (const file of [capsuleCSS, diagramCSS]) assert.equal(loaded.has(file), file !== omit)
    report.cssPhases.push({ mode, sourceSHA256: hashes[formal], loadedSHA256: hash(actual), actualInputs: [...loaded] })
    cssProof.push({ mode, href: pathToFileURL(join(outDir, output[0].fileName)).href })
  }
  assert.equal(report.cssPhases[0].loadedSHA256, report.cssPhases.at(-1).loadedSHA256)
  await writeFile(join(temporary, 'styles.json'), JSON.stringify(cssProof))
  await writeFile(join(temporary, 'renderer-inputs.json'), JSON.stringify(Object.fromEntries(rendererSources.map(file => [file, hashes[file]]))))
  report.rendererBuild = await runProbeProcess(process.execPath, [join(fixture, 'build-renderer.mjs'), join(temporary, 'renderer'),
    join(temporary, 'renderer-inputs.json'), join(temporary, 'renderer-receipt.json')], { cwd: root, env: process.env, timeoutMs: 180000 })
  assert.equal(report.rendererBuild.exitCode, 0, 'The bounded Renderer build must complete before any private native acquisition')
  const rendererReceipt = JSON.parse(await readFile(join(temporary, 'renderer-receipt.json'), 'utf8'))
  report.rendererInputs = rendererReceipt.loaded; report.rendererStoreIO = rendererReceipt.storeIO
  assert.equal(report.rendererStoreIO.edges.length, 1)
  assert.deepEqual(report.rendererStoreIO.allowedStateKeys, ['noticeReadReceipts'])
  for (const file of rendererSources) assert.ok(report.rendererInputs.includes(file), `${file}: the actual consumer must compile`)
  await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'), 'dir')
  const nativeLoaded = new Set()
  await bundle({ absWorkingDir: root, entryPoints: [join(fixture, 'main.ts')], outfile: join(temporary, 'main.mjs'), bundle: true,
    platform: 'node', format: 'esm', packages: 'external', logLevel: 'error', plugins: [{ name: 'current-native-style-owner', setup(build) {
      build.onResolve({ filter: /^@agentmux\/(?:host|client-ui)(?:\/|$)/ }, args => {
        for (const item of aliases) if (item.find.test(args.path)) return { path: args.path.replace(item.find, item.replacement) }
      })
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === 'electron' || args.path.startsWith('@agentmux/')) return
        const path = installedDependency(args.path, args.importer); return path ? { path, external: true } : undefined
      })
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const file = relative(root, args.path); if (!nativeSources.includes(file)) return
        assert.equal(hash(await readFile(args.path)), hashes[file]); nativeLoaded.add(file)
      })
    } }] })
  for (const file of nativeSources) assert.ok(nativeLoaded.has(file), `${file}: the actual native owner must compile`)
  report.nativeInputs = [...nativeLoaded]
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  report.execution = await runProbeProcess(desktopRequire('electron'), [join(root, reused[1]), join(temporary, 'main.mjs'),
    join(temporary, 'renderer/index.html'), join(temporary, 'profile'), evidence, join(root, reused[0]), join(temporary, 'styles.json')],
    { cwd: root, env, timeoutMs: 75000, onLine: line => logs.push(line) })
  await writeFile(join(evidence, 'native.log'), logs.join('\n'))
  report.native = JSON.parse(await readFile(join(evidence, 'native.json'), 'utf8'))
  assert.equal(report.execution.exitCode, 0, report.native.failure?.message); assert.equal(report.native.passed, true)
  assert.equal(report.native.activations.length, 0); assert.equal(report.native.created.length, 1); assert.equal(report.native.remainingWindows, 0)
  assert.equal(report.native.phases.length, 4); report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  if (report.cleanup.remaining.length) report.passed = false
  await rm(temporary, { recursive: true, force: true })
  report.sourceRetention = []
  for (const [file, expected] of Object.entries(hashes)) { const actual = hash(await readFile(join(root, file)))
    report.sourceRetention.push({ file, expected, actual, unchanged: expected === actual }); if (actual !== expected) { report.passed = false; report.failure ??= { name: 'SourceDriftError', message: file } }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null })); process.exitCode = report.passed ? 0 : 1
}
