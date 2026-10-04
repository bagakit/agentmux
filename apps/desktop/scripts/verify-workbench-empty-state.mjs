import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/workbench-empty-state')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/workbench-empty-state', String(globalThis.crypto.randomUUID())))
const privateRoot = await fs.mkdtemp(_hygiene_fixturePath("tmp/amux-empty-workbench-"))
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bench = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const state = 'apps/desktop/src/renderer/src/components/WorkbenchEmptyState.tsx'
const sources = [bench, state, 'apps/desktop/src/renderer/src/components/FullPageLoadingSurface.tsx',
  'apps/desktop/src/renderer/src/styles/full-page-loading.css', 'apps/desktop/src/renderer/src/styles/tokens.css']
const receipt = { schema: 'agentmux.workbench-empty-state.v1', passed: false, visualReview: 'pending-independent-review', mutations: [], productionConsumers: [] }
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.sourceBefore = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(manifest.exports).map(([key, value]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: path.join(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  aliases.push({ find: /^@agentmux\/layout$/, replacement: path.join(root, 'packages/core/src/spatial-layout.ts') })
  const mutations = [
    { name: 'unknown-is-not-loading', file: state, before: 'phase="parked"', after: 'phase="loading"', failure: 'Unconfirmed placement is not active loading' },
    { name: 'full-state-consumed-by-workbench', file: bench, before: '/> : !showReferenceBody ? unplacedSurface : null}', after: '/> : null}', failure: 'One coherent state replaces the banner plus empty canvas' }
  ]
  const execute = async mutation => {
    const label = mutation?.name ?? 'baseline', directory = path.join(evidence, label)
    await fs.mkdir(directory, { recursive: true })
    const compiled = new Map(), loaded = []
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
      resolve: { alias: aliases }, plugins: [{ name: 'empty-workbench-source', enforce: 'pre',
        resolveId(id) {
          if (/^(\.\.\/)+shared\/zone-file-resource(?:\.js)?$/.test(id)) return '\0unused-zone-file-resource'
          if (/(^|\/)ConversationView(?:\.js)?$/.test(id)) return '\0unused-conversation-view'
        },
        load(id) {
          if (id === '\0unused-zone-file-resource') return 'export function zoneFileResource(){throw new Error("Unused file-resource leaf invoked in empty-workbench proof")}'
          if (id === '\0unused-conversation-view') return 'export function ConversationView(){throw new Error("Unused native-history leaf invoked in empty-workbench proof")}'
        },
        transform(source, id) {
          const file = path.relative(root, id.split('?')[0])
          if (!file.startsWith('apps/desktop/src/')) return
          let code = source
          if (mutation?.file === file) {
            assert.equal(source.split(mutation.before).length - 1, 1, 'Unique production mutation anchor')
            code = source.replace(mutation.before, mutation.after)
            loaded.push({ file, sourceSHA256: hash(source), loadedSHA256: hash(code) })
          }
          compiled.set(file, hash(code))
          if (code !== source) return { code, map: null }
        }
      }], build: { outDir: path.join(directory, 'renderer'), emptyOutDir: true, minify: false } })
    for (const file of [bench, state, 'apps/desktop/src/renderer/src/App.tsx']) assert.ok(compiled.has(file), 'Actual compiled production consumer: ' + file)
    const main = path.join(privateRoot, label + '.cjs')
    await fs.copyFile(path.join(fixture, 'main.cjs'), main)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
    const result = await runProbeProcess(require('electron'), [main, path.join(directory, 'renderer/index.html'), privateRoot, directory, mutation ? 'mutation' : 'baseline'],
      { cwd: root, temporaryRoot: privateRoot, env: environment, timeoutMs: 45000, onLine: line => process.stderr.write(line.slice(0, 700) + '\n') })
    const ui = JSON.parse(await fs.readFile(path.join(directory, 'ui-receipt.json'), 'utf8'))
    if (mutation) {
      assert.equal(loaded.length, 1, 'Mutated actual implementation loaded')
      assert.equal(result.exitCode, 1)
      assert.match(ui.failure?.message ?? '', new RegExp(mutation.failure))
      receipt.mutations.push({ ...mutation, loaded: loaded[0], killed: true, failure: ui.failure.message })
    } else {
      assert.equal(result.exitCode, 0, JSON.stringify(ui.failure))
      assert.equal(ui.passed, true)
      receipt.compiledSource = Object.fromEntries(compiled)
      receipt.ui = ui
    }
    console.log('empty-workbench ' + label + ': ' + (mutation ? 'mutation killed' : 'passed'))
  }
  await execute(null)
  for (const mutation of mutations) await execute(mutation)
  const walk = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? walk(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []))).flat()
  const files = await walk(path.join(root, 'apps/desktop/src/renderer/src')); assert.ok(files.length > 0)
  for (const [symbol, definition] of [['WorkbenchEmptyState', state], ['WorkspaceWorkbench', bench]]) {
    const callers = []
    for (const file of files.filter(file => file !== path.join(root, definition))) {
      if (new RegExp('<' + symbol + '\\b').test(await fs.readFile(file, 'utf8'))) callers.push(path.relative(root, file))
    }
    assert.ok(callers.length > 0, 'Nonempty production consumer outside definition: ' + symbol)
    receipt.productionConsumers.push({ symbol, callers })
  }
  receipt.sourceAfter = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Candidate stayed unchanged; mutations are private compiler transforms')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; throw error }
finally {
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await fs.rm(privateRoot, { recursive: true, force: true })
  console.log('empty-workbench evidence=' + evidence)
}
