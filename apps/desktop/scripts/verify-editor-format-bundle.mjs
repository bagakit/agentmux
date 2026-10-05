import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Build the actual Electron config. The observer only records Rollup's compiled graph.
const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(join(desktop, 'package.json'))
const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite')).href)
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
assert.ok(output, 'An explicit local evidence --output=FILE is required.')
const evidence = resolve(output), directory = await mkdtemp(join(tmpdir(), 'amx-editor-bundle-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, targets = {}
const heavyPackage = /\/node_modules\/(?:\.pnpm\/)?(?:mermaid|@viz-js(?:\/|\+)viz|@plantuml(?:\/|\+)core|@excalidraw(?:\/|\+)excalidraw|vega(?:-lite|-interpreter)?|katex|highlight\.js|prettier|smol-toml|yaml)(?:@|\/)/
const report = { passed: false, sources, targets }
try {
  for (const file of ['apps/desktop/scripts/verify-editor-format-bundle.mjs', 'apps/desktop/electron.vite.config.ts',
    'apps/desktop/scripts/file-diagram-assets.ts', 'apps/desktop/scripts/excalidraw-local-fonts.ts',
    'apps/desktop/package.json', 'packages/client-ui/package.json', 'pnpm-lock.yaml']) {
    sources[file] = sha(await readFile(join(repository, file)))
  }
  // Copied assets do not pass through Rollup transforms, so bind their original
  // bytes separately from the compiled module graph.
  for (const root of [join(desktop, 'vendor/drawio/v32.4.1'),
    join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')]) {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name)
      sources[relative(repository, file)] = sha(await readFile(file))
    }
  }
  const plantuml = dirname(require.resolve('@plantuml/core/package.json'))
  for (const name of ['viz-global.js', 'plantuml.js', 'themes.js', 'emoji.js', 'openiconic.js', 'LICENSE']) {
    const file = join(plantuml, name)
    sources[relative(repository, file)] = sha(await readFile(file))
  }
  process.chdir(desktop)
  process.env.NODE_ENV_ELECTRON_VITE = 'production'
  const { config } = await resolveConfig({ root: desktop, configFile: join(desktop, 'electron.vite.config.ts'), logLevel: 'error' }, 'build', 'production')
  assert.ok(config?.main && config.preload && config.renderer, 'Full production Electron targets are required.')
  for (const target of ['main', 'preload', 'renderer']) {
    const chunks = [], setting = config[target]
    setting.plugins = [...(setting.plugins ?? []), {
      name: 'observe-editor-production-bundle', enforce: 'pre',
      async transform(_code, id) {
        const file = id.split('?')[0]
        if (!file.startsWith(repository + '/') || file.includes('/node_modules/') || file.includes('/.tmp/') || file.includes('/.bagakit/')) return
        let bytes
        try { bytes = await readFile(file) } catch { return }
        const key = relative(repository, file), digest = sha(bytes)
        if (sources[key]) assert.equal(sources[key], digest, `Source changed while building: ${key}`)
        sources[key] = digest
      },
      generateBundle(_options, bundle) {
        for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.push({
          file: item.fileName, entry: item.isEntry, facade: item.facadeModuleId ? relative(repository, item.facadeModuleId) : null,
          imports: item.imports, dynamicImports: item.dynamicImports,
          modules: Object.keys(item.modules).map(id => relative(repository, id))
        })
      }
    }]
    setting.build = { ...setting.build, outDir: join(directory, target), watch: null, emptyOutDir: true }
    await build(setting)
    assert.ok(chunks.length, `Nonempty compiled ${target} chunks`)
    targets[target] = { chunks, artifacts: {} }
    for (const file of await readdir(join(directory, target), { recursive: true, withFileTypes: true })) if (file.isFile()) {
      const path = join(file.parentPath, file.name)
      targets[target].artifacts[relative(join(directory, target), path)] = sha(await readFile(path))
    }
  }
  const chunks = targets.renderer.chunks, byFile = new Map(chunks.map(chunk => [chunk.file, chunk]))
  const entry = chunks.find(chunk => chunk.entry && chunk.facade === 'apps/desktop/src/renderer/index.html')
  assert.ok(entry, 'The actual application HTML entry was compiled.')
  const closure = new Set(), visit = file => {
    if (closure.has(file)) return
    closure.add(file)
    for (const dependency of byFile.get(file)?.imports ?? []) visit(dependency)
  }
  visit(entry.file)
  const modules = [...closure].flatMap(file => byFile.get(file)?.modules ?? [])
  assert.ok(modules.length > 0, 'Nonempty startup module graph')
  const eagerEngines = modules.filter(id => heavyPackage.test('/' + id))
  // YAML already serves the startup Mote preference owner. Its existing use is
  // separate from this feature's Worker-only file parser; report both honestly.
  const sharedYaml = eagerEngines.filter(id => /\/yaml(?:@|\/)/.test('/' + id))
  const isolated = eagerEngines.filter(id => !sharedYaml.includes(id))
  assert.deepEqual(isolated, [], 'New format engines must be outside the actual App static import closure.')
  if (sharedYaml.length) for (const file of ['apps/desktop/src/shared/mote-behavior.ts', 'apps/desktop/src/shared/mote-quick-mode.ts']) {
    assert.ok(modules.includes(file), `Existing shared YAML consumer: ${file}`)
  }
  assert.deepEqual(modules.filter(id => /\/file-formats\/(?:data-config|data-parse|vega-spec|mermaid-engine|dot-engine|drawio-engine|plantuml-engine|format-content)\.ts$/.test(id)), [], 'File parser/compiler implementations stay outside startup.')
  const artifacts = Object.keys(targets.renderer.artifacts)
  for (const pattern of [/markdown-render\.worker-.*\.js$/, /data-structured\.worker-.*\.js$/, /data-notebook\.worker-.*\.js$/, /dot-worker-.*\.js$/, /format-worker-.*\.js$/, /vega-chart\.worker-.*\.js$/]) {
    assert.ok(artifacts.some(file => pattern.test(file)), `Actual emitted lazy Worker: ${pattern}`)
  }
  for (const file of ['file-diagram/index.html', 'diagram-assets/drawio/js/viewer-static.min.js', 'diagram-assets/drawio/LICENSE', 'diagram-assets/plantuml/plantuml.js', 'diagram-assets/plantuml/LICENSE']) {
    assert.ok(targets.renderer.artifacts[file], `Actual packaged offline asset: ${file}`)
  }
  assert.ok(artifacts.some(file => file.startsWith('excalidraw-assets/fonts/')), 'Local Excalidraw fonts were packaged.')
  for (const [file, digest] of Object.entries(sources)) assert.equal(sha(await readFile(join(repository, file))), digest, `Final source identity: ${file}`)
  report.startup = { entry: entry.file, chunks: [...closure], moduleCount: modules.length, eagerFormatEngines: isolated,
    sharedDependencies: sharedYaml.length ? [{ package: 'yaml', reason: 'Existing startup Mote preference consumers', modules: sharedYaml }] : [] }
  report.passed = true
} catch (error) { report.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(directory, { recursive: true, force: true })
  report.cleanup = { buildDirectoryRemoved: true }
  await mkdir(dirname(evidence), { recursive: true })
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, evidence, startup: report.startup && {
    chunks: report.startup.chunks.length, modules: report.startup.moduleCount, eagerFormatEngines: report.startup.eagerFormatEngines,
    sharedDependencies: report.startup.sharedDependencies.map(item => item.package)
  }, failure: report.failure?.message }))
  process.exitCode = report.passed ? 0 : 1
}
