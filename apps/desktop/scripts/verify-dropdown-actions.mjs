import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { build } from 'vite'
import { runProbeProcess } from './probe-process.mjs'
import { radixOverlayAliases } from '../../../packages/client-ui/scripts/radix-overlay-aliases.ts'

const root = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/dropdown-actions')
const require = createRequire(import.meta.url)
const evidenceRoot = join(root, '.tmp/dropdown-actions')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'capture-'))
const adapter = 'apps/desktop/src/renderer/src/components/DropdownMenu.tsx'
const product = 'apps/desktop/src/renderer/src/components/image-annotation/AnnotationOriginalMenu.tsx'
const editor = 'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx'
const shared = 'packages/client-ui/src/components/DropdownMenu.tsx'
const styles = 'packages/client-ui/src/styles/overlays.css'
const menuPrimitive = '/@radix-ui/react-menu/dist/index.mjs'
const digest = value => createHash('sha256').update(value).digest('hex')

async function run(mutation) {
  const output = join(evidence, mutation ?? 'original')
  const compiled = join(output, 'app')
  await mkdir(output)
  const loaded = {}
  let mutations = 0, primitive
  try {
    await build({
      root: fixture, configFile: false, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
      resolve: { alias: radixOverlayAliases, dedupe: ['react', 'react-dom'] },
      plugins: [{
        name: 'actual-dropdown-consumer', enforce: 'pre',
        transform(source, id) {
          if (id.endsWith(menuPrimitive)) {
            const before = 'const ownerDocument = anchorDocument ?? content?.ownerDocument ?? globalThis.document;'
            assert.equal(source.split(before).length, 2, 'The real patched menu must track its invoking document')
            if (mutation === 'global-keyboard') {
              source = source.replace(before, 'const ownerDocument = globalThis.document;')
              mutations++
            }
            primitive = digest(source)
            if (mutation === 'global-keyboard') return source
          }
          const file = relative(root, id)
          if (![adapter, editor, product, shared].includes(file)) return
          if (file === adapter && mutation === 'wrong-document') {
            const before = '<DocumentOverlayPortal component={SharedPortal} container={container} {...props} />'
            assert.equal(source.split(before).length, 2, 'Mutate exactly one loaded host target')
            source = source.replace(before, '<SharedPortal container={globalThis.document.body} {...props} />')
            mutations++
          }
          if (file === editor && mutation === 'missing-primary-action') {
            const before = 'variant="primary" type="button" disabled={busy || !loaded} onClick={() => complete()}'
            assert.equal(source.split(before).length, 2, 'Mutate the real migrated Copy PNG control exactly once')
            source = source.replace(before, 'variant="primary" type="button" disabled={busy || !loaded}')
            mutations++
          }
          loaded[file] = digest(source)
          if ((file === adapter && mutation === 'wrong-document') || (file === editor && mutation === 'missing-primary-action')) return source
        },
        async generateBundle() {
          const files = this.getWatchFiles()
          for (const file of [join(root, styles), ...Object.values(radixOverlayAliases)]) {
            assert.ok(files.includes(file), 'The actual production overlay contract must load: ' + file)
          }
          loaded[styles] = digest(await readFile(join(root, styles)))
        }
      }],
      build: { target: 'esnext', outDir: compiled, emptyOutDir: true, reportCompressedSize: false }
    })
    assert.deepEqual(Object.keys(loaded).sort(), [adapter, editor, product, shared, styles].sort())
    assert.ok(primitive, 'The edited production Radix Menu must actually compile')
    assert.equal(mutations, mutation ? 1 : 0)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const execution = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(compiled, 'index.html'), output],
      { temporaryRoot: output, cwd: root, env, timeoutMs: 25_000 })
    assert.equal(execution.exitConfirmed, true)
    const result = JSON.parse(await readFile(join(output, 'renderer.json'), 'utf8'))
    if (mutation) {
      assert.equal(execution.exitCode, 1, result.failure)
      assert.equal(result.failure.split('\n', 1)[0], mutation === 'wrong-document'
        ? 'The file menu opens in the original second document and modal slot'
        : mutation === 'global-keyboard' ? 'ArrowDown activates the click menu and focuses the first original action'
          : 'The shared primary button invokes its original output once')
    } else {
      assert.equal(execution.exitCode, 0, result.failure)
      assert.equal(result.passed, true)
      assert.equal(result.cases.length, 4)
    }
    const frames = Object.fromEntries(await Promise.all(result.frames.map(async frame => [frame, digest(await readFile(join(output, frame)))])))
    return { loaded, primitive, frames, result }
  } finally {
    await rm(compiled, { recursive: true, force: true })
  }
}

const original = await run()
const wrongDocument = await run('wrong-document')
const globalKeyboard = await run('global-keyboard')
const missingPrimaryAction = await run('missing-primary-action')
assert.notEqual(wrongDocument.loaded[adapter], original.loaded[adapter])
assert.equal(wrongDocument.primitive, original.primitive)
assert.notEqual(globalKeyboard.primitive, original.primitive)
assert.deepEqual(globalKeyboard.loaded, original.loaded)
assert.equal(missingPrimaryAction.primitive, original.primitive)
assert.notEqual(missingPrimaryAction.loaded[editor], original.loaded[editor])
for (const file of [adapter, product, shared, styles]) assert.equal(missingPrimaryAction.loaded[file], original.loaded[file])
for (const file of [editor, product, shared, styles]) assert.equal(wrongDocument.loaded[file], original.loaded[file])
const goal = 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'
const test = 'apps/desktop/test/ui-button-consumers.test.tsx'
const config = 'apps/desktop/test/ui-button-consumers.config.mts'
const goalInputs = await Promise.all([goal, test, config].map(async file => [file, digest(await readFile(join(root, file)))]))
const goalLoaded = join(evidence, 'goal-source.ndjson')
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const goalResult = execFileSync(process.execPath, [vitest, 'run', '--config', config, test, '--pool', 'forks',
  '-t', 'uses the real GoalDetail menu'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', AGENTMUX_UNIFIED_LOADED: goalLoaded },
  encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 65_000 })
assert.match(goalResult, /Tests\s+1 passed\b/, 'The product Goal action test must actually run and pass')
const loadedGoalRecords = (await readFile(goalLoaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
assert.ok(loadedGoalRecords.some(record => record.path === goal && record.sha256 === goalInputs[0][1]), 'The Goal test consumes this exact product source')
const goalLog = join(evidence, 'goal-actions.log')
await writeFile(goalLog, goalResult)
const receipt = join(evidence, 'receipt.json')
await writeFile(receipt, JSON.stringify({ passed: true, original, wrongDocument, globalKeyboard, missingPrimaryAction,
  goalActions: { inputs: Object.fromEntries(goalInputs), log: relative(root, goalLog) } }, null, 2) + '\n')
console.log(relative(root, receipt))
