import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { aliases, installedDependency } from './fixtures/settings-resource-library/environment.mjs'
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: bundle } = createRequire(require.resolve('vite/package.json'))('esbuild')
const fixture = join(desktop, 'scripts/fixtures/conversation-capsule')
const sources = ['packages/client-ui/src/components/AgentMarkdown.tsx', 'packages/client-ui/src/platform.tsx',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'apps/desktop/src/renderer/src/components/ConversationCapsule.tsx',
  'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx', 'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts',
  'apps/desktop/src/renderer/src/lib/browser-stage-geometry.ts', 'packages/client-ui/src/styles/conversation-capsule.css',
  'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/capsule-presentation.ts',
  'packages/client-ui/src/components/ConversationInputText.tsx', 'packages/client-ui/src/components/ConversationResourceText.tsx',
  'apps/desktop/src/renderer/src/lib/workbench-document.tsx', 'apps/desktop/src/main/workbench-windows.ts', 'apps/desktop/src/main/workbench-window-store.ts',
  'apps/desktop/src/renderer/src/components/ConversationReadingRuler.tsx', 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx', 'apps/desktop/src/renderer/src/lib/use-conversation-keyframes.ts',
  'apps/desktop/src/renderer/src/components/CapsuleInteractionChrome.tsx', 'apps/desktop/src/renderer/src/components/CapsuleQuestionReply.tsx',
  'apps/desktop/src/shared/contracts.ts', 'packages/core/guides/modules/capsule.md', 'packages/core/src/generated/agentmux-guides.ts',
  'apps/desktop/test/conversation-capsule.test.tsx', 'apps/desktop/test/conversation-capsule.config.mts',
  'apps/desktop/test/capsule-chrome.test.tsx', 'apps/desktop/test/capsule-partial-recovery.test.tsx',
  ...['entry.tsx', 'main.ts', 'api.ts', 'preload.cjs', 'bootstrap.cjs', 'index.html'].map(name => `apps/desktop/scripts/fixtures/conversation-capsule/${name}`),
  'apps/desktop/scripts/verify-conversation-capsule.mjs',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/main/ipc.ts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])))
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp/capsule-embed-private-'))
const evidence = await mkdtemp(join(root, '.tmp/capsule-embed-evidence-'))
const report = { passed: false, sources: hashes, evidence, phases: [],
  boundary: 'Private Electron: real shared ConversationMessage/AgentMarkdown, production ConversationCapsule/native Stage, actual BrowserViewManager, original Capsule acquisition helper and NodeCapsuleOwner HTTP/SDK. Only fixture transport and body placement substitute Desktop IPC/Workbench. Installed product, full spatial restoration and user Runs are outside this receipt.' }
let nativeStarted = false
try {
  const vitest = join(dirname(createRequire(join(root, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs')
  const unit = await runProbeProcess(process.execPath, [vitest, 'run', '--config', 'apps/desktop/test/conversation-capsule.config.mts', '--configLoader', 'runner', '--reporter=dot'],
    { cwd: root, env: process.env, timeoutMs: 60000 })
  report.unit = unit
  assert.equal(unit.exitCode, 0, 'The exact owning consumer/native suites must pass')
  const provider = await readFile(join(root, sources.at(-2)), 'utf8'), ipc = await readFile(join(root, sources.at(-1)), 'utf8')
  assert.ok(provider.includes('renderCapsuleEmbed: input => <ConversationCapsule'), 'The actual Desktop platform must instantiate this Capsule consumer')
  assert.ok(ipc.includes('return await createCapsuleBrowserDocument('), 'The actual Main IPC must consume the exact original acquisition helper')
  assert.ok(ipc.includes('args.workbenchWindows.windowForDocument(document)'), 'Inline native display must use the original native document owner')
  report.consumers = { provider: hashes[sources.at(-2)], ipc: hashes[sources.at(-1)] }
  await mkdir(join(temporary, 'preload'), { recursive: true }); await mkdir(join(temporary, 'main'), { recursive: true })
  await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'), 'dir')
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
  await bundle({ entryPoints: [join(desktop, 'src/preload/capsule.ts')], outfile: join(temporary, 'preload/capsule.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'error' })
  const loaded = []
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: [{ find: /^jsonc-parser$/, replacement: join(dirname(require.resolve('jsonc-parser/package.json')), 'lib/esm/main.js') }, ...aliases] }, worker: { format: 'es' }, define: { 'process.env.NODE_ENV': '"production"', __AGENTMUX_WEB_PREVIEW__: 'true' },
    plugins: [{ name: 'exact-capsule-renderer-consumption', enforce: 'pre',
      resolveId(source, importer) {
        if (/(?:^|\/)api(?:\.ts)?$/u.test(source) && importer?.includes('/renderer/src/')) return join(fixture, 'api.ts')
        return installedDependency(source, importer)
      }, transform(code, id) { const path = relative(root, id.split('?')[0]); if (sources.includes(path)) { assert.equal(hash(code), hashes[path]); loaded.push(path) }; return null }
    }], build: { outDir: join(temporary, 'renderer'), emptyOutDir: true, minify: false } })
  for (const path of sources.slice(0, 8)) assert.ok(loaded.includes(path), `The production renderer must actually compile ${path}`)
  report.rendererLoaded = loaded
  for (const phase of ['green', 'clipped-input-mutant', 'restored']) {
    let mutated = 0
    const native = join(temporary, 'main', `${phase}.mjs`)
    await bundle({ entryPoints: [join(fixture, 'main.ts')], outfile: native, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'error',
      plugins: [{ name: 'native-input-geometry-mutation', setup(builder) {
        builder.onLoad({ filter: /browser-view-manager\.ts$/ }, async ({ path }) => {
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
    const profile = join(temporary, `profile-${phase}`)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(environment, { HOME: profile, TMPDIR: temporary })
    const lines = []
    nativeStarted = true
    const execution = await runProbeProcess(require('electron'), [join(fixture, 'bootstrap.cjs'), native, join(temporary, 'renderer/index.html'), profile, evidence, join(fixture, 'preload.cjs'), phase],
      { cwd: root, env: environment, timeoutMs: 120000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, `${phase}.log`), lines.join('\n'))
    report.currentNativeExecution = execution
    const nativeReport = JSON.parse(await readFile(join(evidence, `${phase}.native.json`), 'utf8'))
    report.phases.push({ phase, execution, mutated, nativeReport })
    if (phase === 'clipped-input-mutant') {
      assert.equal(mutated, 1); assert.notEqual(execution.exitCode, 0)
      assert.equal(nativeReport.failure?.name, 'AssertionError')
      assert.match(nativeReport.failure?.message ?? '', /clipped card cannot cover adjacent conversation content/)
    } else { assert.equal(execution.exitCode, 0, nativeReport.failure?.message); assert.equal(nativeReport.passed, true) }
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
