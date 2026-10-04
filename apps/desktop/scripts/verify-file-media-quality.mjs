import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(root, process.argv[2] ?? '.bagakit/reviews/file-media-quality')
const pdf = 'apps/desktop/src/renderer/src/components/PdfContent.tsx'
const assets = 'apps/desktop/scripts/pdfjs-viewer-assets.ts'
const config = 'apps/desktop/test/fixtures/file-media/vitest.config.ts'
const tests = ['apps/desktop/test/pdf-content.test.tsx', 'apps/desktop/test/pdfjs-viewer-assets.test.ts', 'apps/desktop/test/pdf-engine.test.ts']
const files = [pdf, assets, config, ...tests, 'apps/desktop/src/renderer/src/components/FilePreviewState.tsx', 'apps/desktop/src/renderer/src/styles/pdf-content.css', 'apps/desktop/test/helpers/pdf-reader-fixture.ts']
const digest = text => createHash('sha256').update(text).digest('hex')
const originals = new Map(files.map(path => [path, readFileSync(resolve(root, path), 'utf8')]))
const isolated = mkdtempSync(join(tmpdir(), 'agentmux-pdf-quality-'))
mkdirSync(output, { recursive: true })
const receipt = { schema: 'agentmux.file-media-quality.v1', source: Object.fromEntries([...originals].map(([path, text]) => [path, digest(text)])), green: null, mutations: [], callers: null, restored: null }
const run = (id, testFiles = tests) => {
  const argv = ['run', '--config', config, ...testFiles, '--maxWorkers=1']
  const result = spawnSync(resolve(root, 'node_modules/.bin/vitest'), argv, { cwd: isolated, env: { ...process.env, AGENTMUX_FILE_MEDIA_DEPENDENCY_ROOT: root }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(resolve(output, `${id}.log`), log)
  assert(!result.error, result.error?.message)
  assert(!/No test files found|No tests found/u.test(log), `${id} must load real owning tests`)
  const executedTests = Number(/Tests[^\n]*\((\d+)\)/u.exec(log)?.[1] ?? 0)
  assert(executedTests > 0, `${id} must execute a nonempty owning assertion set`)
  return { id, executedTests, exitCode: result.status, assertionRed: result.status !== 0 && /AssertionError:/u.test(log), log: `${id}.log` }
}
const cases = [
  ['byte-copy-removed', pdf, 'data: data.slice(),', 'data,'],
  ['false-ready-before-render', pdf, "update({ phase: 'rendering', pages: document.numPages })", "update({ phase: 'ready', pages: document.numPages })"],
  ['late-load-fence-removed', pdf, 'if (disposed || !reader) return\n        password.current = null', 'if (!reader) return\n        password.current = null'],
  ['worker-release-removed', pdf, 'void loading?.destroy().catch(() => {})', 'void loading'],
  ['viewer-abort-removed', pdf, 'lifetime.abort()', 'void lifetime'],
  ['hidden-read-admission-removed', pdf, 'if (!visible) { setReading(null); return }', 'if (false) { setReading(null); return }'],
  ['hidden-state-byte-release-removed', pdf, 'if (!visible) { setReading(null); return }', 'if (!visible) { return }'],
  ['page-recovery-disabled', pdf, 'if (!viewer.current || !current?.pages || !Number.isFinite(value)) return', 'if (!ready || !viewer.current || !current?.pages || !Number.isFinite(value)) return'],
  ['cached-page-recovery-removed', pdf, 'reader?.getPageView(event.pageNumber - 1)?.renderingState === components.RenderingStates.FINISHED', 'false'],
  ['canvas-budget-removed', pdf, 'maxCanvasPixels: 16 * 1024 * 1024', 'maxCanvasPixels: -1'],
  ['wasm-assets-missing', assets, "['cmaps', 'standard_fonts', 'wasm', 'iccs']", "['cmaps', 'standard_fonts', 'iccs']"],
  ['abandoned-stream-release-removed', assets, "response.once('close', stop); response.once('error', stop)", "response.once('error', stop)"]
]
try {
  for (const path of files) { const target = resolve(isolated, path); mkdirSync(dirname(target), { recursive: true }); cpSync(resolve(root, path), target) }
  symlinkSync(resolve(root, 'node_modules'), resolve(isolated, 'node_modules'), 'dir')
  symlinkSync(resolve(root, 'apps/desktop/node_modules'), resolve(isolated, 'apps/desktop/node_modules'), 'dir')
  receipt.green = run('owning-green'); assert.equal(receipt.green.exitCode, 0, 'Owning exact source must be green')
  for (const [id, path, before, after] of cases) {
    const original = originals.get(path)
    assert.equal(original.split(before).length, 2, `Mutation anchor must occur exactly once: ${id}`)
    writeFileSync(resolve(isolated, path), original.replace(before, after))
    try {
      const result = run(id, path === assets ? tests.slice(1, 2) : tests.slice(0, 1))
      receipt.mutations.push({ ...result, source: path })
      assert(result.assertionRed, `${id} must reach and fail an actual loaded-source assertion`)
    } finally { writeFileSync(resolve(isolated, path), original) }
  }
  receipt.restored = run('restored-green'); assert.equal(receipt.restored.exitCode, 0, 'Restored source must pass owning tests')
  const caller = (symbol, scope, defining) => {
    const result = spawnSync('rg', ['-n', '--glob', '*.ts', '--glob', '*.tsx', symbol, ...scope], { cwd: root, encoding: 'utf8' })
    const found = (result.stdout ?? '').split('\n').filter(line => line && !line.startsWith(`${defining}:`))
    assert(found.length > 0, `${symbol} has no outside-definition production caller; task is blocked`)
    return found
  }
  receipt.callers = { PdfContent: caller('PdfContent', ['apps/desktop/src/renderer/src/components'], pdf),
    pdfjsViewerAssets: caller('pdfjsViewerAssets', ['apps/desktop/electron.vite.config.ts', 'apps/desktop/vite.web.config.ts', 'apps/desktop/vite.gallery.config.ts'], assets) }
} finally {
  for (const [path, original] of originals) assert.equal(digest(readFileSync(resolve(root, path), 'utf8')), digest(original), `Concurrent product source must stay intact: ${path}`)
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  rmSync(isolated, { recursive: true, force: true })
}
console.log(JSON.stringify({ tests: receipt.green.executedTests, mutations: receipt.mutations.length, assertionRed: receipt.mutations.filter(item => item.assertionRed).length, restored: receipt.restored.exitCode, output }))
