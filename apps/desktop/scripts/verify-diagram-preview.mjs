import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { fixturePath } from './lib/fixture-values.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: bundle } = createRequire(require.resolve('vite/package.json'))('esbuild')
const fixture = join(desktop, 'scripts/fixtures/diagram-preview')
const style = 'packages/client-ui/src/styles/diagram-image.css'
const consumerFiles = ['apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx']
const compiledFiles = [style, 'packages/client-ui/src/components/DiagramImage.tsx', 'packages/client-ui/src/components/ConversationImageViewport.tsx',
  'packages/client-ui/src/lib/diagram-svg-image.ts',
  'packages/client-ui/src/theme/runtime.ts', 'packages/client-ui/src/theme/icon-sprite.ts',
  'packages/client-ui/src/styles/conversation-image.css', 'packages/client-ui/src/components/AgentMarkdown.tsx', 'packages/client-ui/src/components/MarkdownCodeBlock.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/DiagramFilePreview.tsx', 'apps/desktop/src/renderer/src/components/file-preview/DotFilePreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/DrawioFilePreview.tsx', 'apps/desktop/src/renderer/src/lib/file-formats/dot-worker.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/dot-engine.ts']
const engineFiles = ['apps/desktop/src/renderer/file-diagram/entry.ts', ...['mermaid-engine', 'drawio-engine', 'plantuml-engine', 'diagram-script'].map(file => `apps/desktop/src/renderer/src/lib/file-formats/${file}.ts`)]
const sourceFiles = [...compiledFiles, ...engineFiles, ...consumerFiles, 'apps/desktop/src/main/file-diagram-renderer.ts']
const fixtureFiles = ['verify-diagram-preview.mjs', ...(await readdir(fixture)).map(file => `fixtures/diagram-preview/${file}`)].map(file => `apps/desktop/scripts/${file}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
const fixtureHashes = Object.fromEntries(await Promise.all(fixtureFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
await mkdir(join(root, '.tmp'), { recursive: true })
const evidence = await mkdtemp(join(root, '.tmp/diagram-preview-'))
const temporary = await mkdtemp(fixturePath('tmp/amx-diagram-preview-'))
const report = { passed: false, evidence, sourceHashes: hashes, fixtureHashes, phases: [],
  boundary: 'Real Chromium in private sandboxed Electron, ordinary production AgentMarkdown → public ClientUiPlatform adapter → production Preview → real Main FileDiagramRenderer / real DOT Worker. The focused adapter substitutes only Desktop IPC transport and body overlay placement; it does not exercise full Workbench/File/Session placement. Source consumers are separately checked for nonempty shared consumption. No user Session or Browser is touched.' }
function loadedSource(mode, loaded) {
  return { name: `diagram-proof-${mode}`, enforce: 'pre',
    resolveId(source, importer) {
      if (source === '../../lib/api' && importer?.replaceAll('\\', '/').includes('/components/file-preview/DiagramFilePreview.tsx')) return join(fixture, 'api.ts')
    },
    transform(code, id) {
      const file = relative(root, id.split('?')[0])
      if (!sourceFiles.includes(file)) return null
      assert.equal(hash(code), hashes[file], `${file}: loaded bytes must match the candidate`)
      let actual = code
      if (mode === 'uncapped-height' && file === style) {
        const anchor = 'max-height: min(300px, 50dvh);'
        assert.equal(code.split(anchor).length - 1, 1, 'The mutation must hit exactly the production thumbnail height rule')
        actual = code.replace(anchor, 'max-height: none;')
      }
      loaded.push({ path: file, sourceSHA256: hash(code), loadedSHA256: hash(actual), mutated: actual !== code })
      return actual === code ? null : actual
    } }
}
try {
  const unitLogs = []
  report.unit = await runProbeProcess('pnpm', ['--filter', '@agentmux/desktop', 'exec', 'vitest', 'run', '--configLoader', 'runner', '--config', 'test/diagram-format.config.mts', 'test/diagram-file-preview.test.tsx'],
    { cwd: root, env: process.env, timeoutMs: 45000, onLine: line => unitLogs.push(line) })
  await writeFile(join(evidence, 'unit.log'), unitLogs.join('\n'))
  assert.equal(report.unit.exitCode, 0, 'The owning isolated unit suite must pass before browser proof')
  report.consumers = []
  for (const file of consumerFiles) {
    const code = await readFile(join(root, file), 'utf8')
    const requirements = file.endsWith('DesktopClientUiProvider.tsx')
      ? ['renderMarkdownDiagram:', '<DotFilePreview content={code}', '<DrawioFilePreview content={code}', '<DiagramFilePreview kind={language}']
      : ['case \'mermaid\': return <DiagramFilePreview', 'case \'dot\': return <DotFilePreview', 'case \'drawio\': return <DrawioFilePreview', 'case \'plantuml\': return <PlantUmlFilePreview', 'case \'markdown\': return <ReadingFind', '<AgentMarkdown documentMode']
    for (const text of requirements) assert.ok(code.includes(text), `${file}: actual nonempty product consumer must retain ${text}`)
    report.consumers.push({ path: file, sourceSHA256: hashes[file], assertions: requirements.length })
  }
  const engineOut = join(temporary, 'engine'), engineLoaded = []
  await build({ configFile: false, root: join(desktop, 'src/renderer'), base: './', logLevel: 'error', plugins: [loadedSource('engine', engineLoaded)],
    build: { outDir: engineOut, emptyOutDir: true, rollupOptions: { input: join(desktop, 'src/renderer/file-diagram/index.html') } } })
  for (const file of engineFiles) assert.ok(engineLoaded.some(item => item.path === file), `${file}: the real private engine must be compiled`)
  report.engineLoaded = engineLoaded
  const assets = join(engineOut, 'diagram-assets')
  await mkdir(assets, { recursive: true })
  // Official fixed assets are referenced in place; never copy a vendor tree for each phase.
  await symlink(join(desktop, 'vendor/drawio/v32.4.1'), join(assets, 'drawio'))
  await symlink(dirname(require.resolve('@plantuml/core/package.json')), join(assets, 'plantuml'))
  const native = join(temporary, 'native.mjs')
  await bundle({ entryPoints: [join(desktop, 'src/main/file-diagram-renderer.ts')], outfile: native, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'error' })
  await mkdir(join(temporary, 'node_modules'), { recursive: true })
  await symlink(join(desktop, 'node_modules/electron'), join(temporary, 'node_modules/electron'))
  report.nativeBundleSHA256 = hash(await readFile(native))
  for (const mode of ['green', 'uncapped-height', 'restored']) {
    const loaded = [], outDir = join(temporary, 'out')
    const plugin = loadedSource(mode, loaded)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
      plugins: [plugin], worker: { format: 'es', plugins: () => [loadedSource(mode, loaded)] }, build: { outDir, emptyOutDir: true } })
    for (const file of compiledFiles) assert.ok(loaded.some(item => item.path === file), `${file}: the actual preview module must be compiled`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    const logs = []
    const outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), join(temporary, `profile-${mode}`), evidence, mode, native, join(engineOut, 'file-diagram/index.html')],
      { cwd: root, env, timeoutMs: 180000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, `${mode}.log`), logs.join('\n'))
    const render = JSON.parse(await readFile(join(evidence, `${mode}.render.json`), 'utf8'))
    report.phases.push({ mode, loaded, outcome, render })
    if (mode === 'uncapped-height') {
      assert.notEqual(outcome.exitCode, 0, 'Removing the production height rule must turn behavior red')
      assert.equal(render.failure?.name, 'AssertionError', 'The mutation must fail behavior, not startup')
      assert.match(render.failure?.message ?? '', /Thumbnail must obey 300px and 50dvh height cap/)
      assert.ok(loaded.some(item => item.mutated), 'The actual production CSS must be mutated in the compiled bundle')
    } else {
      assert.equal(outcome.exitCode, 0, render.failure?.message)
      assert.equal(render.passed, true)
      assert.equal(render.scenarios.length, 9, 'All formats and dimensional pressure scenarios must be observed')
      assert.equal(render.remainingWindows, 0, 'Every isolated engine and image viewer must be closed')
    }
    await rm(join(temporary, `profile-${mode}`), { recursive: true, force: true })
  }
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  assert.equal(report.cleanup.remaining.length, 0, 'Private diagram processes must be cleaned up')
  await rm(temporary, { recursive: true, force: true })
  // Never write a mutation to candidate source; prove all original bytes were retained.
  report.sourceRetention = []
  for (const [file, expected] of Object.entries({ ...hashes, ...fixtureHashes })) {
    const actual = hash(await readFile(join(root, file)))
    report.sourceRetention.push({ path: file, expected, actual, unchanged: actual === expected })
    if (actual !== expected) {
      report.passed = false
      report.failure ??= { name: 'SourceDriftError', message: `${file}: candidate bytes changed during the proof; repeat against the final candidate.` }
    }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null }))
  process.exitCode = report.passed ? 0 : 1
}
