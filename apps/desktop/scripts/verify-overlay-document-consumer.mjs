import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { build } from 'vite'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/overlay-document-consumer')
const require = createRequire(import.meta.url)
const output = join(root, '.tmp/overlay-document-consumer')
await mkdir(output, { recursive: true })
const evidence = await mkdtemp(join(output, 'capture-'))
const renderer = join(evidence, 'app')
const mutation = process.argv.includes('--use-global-document') ? 'global-document'
  : process.argv.includes('--previous-layer-registration') ? 'previous-layer-registration' : null
const shared = 'packages/client-ui/src/components/Modal.tsx'
const chain = [shared, 'packages/client-ui/src/overlay-host.tsx',
  'apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx',
  'apps/desktop/src/renderer/src/components/TopicCategoryDialog.tsx',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx']
const loaded = {}
const layerEntry = '/@radix-ui/react-dismissable-layer/dist/index.mjs'
let layerHash
const digest = source => createHash('sha256').update(source).digest('hex')
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'original-overlay-consumers', enforce: 'pre', transform(source, id) {
      if (id.endsWith(layerEntry) && source.includes('getDocumentLayers')) {
        let candidate = source
        if (mutation === 'previous-layer-registration') {
          const subscribeStart = source.indexOf('    // Listen before registering into a new document')
          const returnStart = source.indexOf('    return /*', subscribeStart)
          const registerStart = source.indexOf('    React.useEffect(() => {\n      if (!node) return;')
          assert.ok(subscribeStart > 0 && registerStart > subscribeStart && returnStart > registerStart)
          candidate = (source.slice(0, subscribeStart) + source.slice(registerStart, returnStart) +
            source.slice(subscribeStart, registerStart) + source.slice(returnStart))
            .replace('const isHighestLayer = index >= 0 && index === layers.length - 1;', 'const isHighestLayer = node ? index === layers.length - 1 : false;')
        }
        layerHash = digest(candidate)
        return candidate === source ? undefined : candidate
      }
      const file = relative(root, id)
      if (!chain.includes(file)) return
      if (mutation !== 'global-document' || file !== shared) { loaded[file] = digest(source); return }
      const statement = 'const ownerDocument = hostContainer?.ownerDocument ?? overlayHost?.ownerDocument ?? globalThis.document'
      assert.equal(source.split(statement).length, 2, 'One real shared document selector must be privately mutated')
      const altered = source.replace(statement, 'const ownerDocument = globalThis.document')
      loaded[file] = digest(altered)
      return altered
    } }],
    build: { outDir: renderer, emptyOutDir: true, target: 'esnext', reportCompressedSize: false }
  })
  for (const file of chain) assert.ok(loaded[file], 'Original product source must load: ' + file)
  assert.ok(layerHash, 'Load the actual maintained per-document Radix layer')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const processResult = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(renderer, 'index.html'), evidence],
    { temporaryRoot: evidence, cwd: root, env, timeoutMs: 60_000 })
  const result = JSON.parse(await readFile(join(evidence, 'renderer.json'), 'utf8'))
  assert.equal(processResult.exitConfirmed, true)
  if (mutation) {
    assert.equal(processResult.exitCode, 1)
    assert.equal(result.passed, false)
    if (mutation === 'global-document') {
      assert.equal(result.failure, 'Category overlay and focus must belong to the original second document')
    } else {
      assert.deepEqual(result.cases, ['ordinary-second-window-escape', 'rapid-reopen-cancel-reduced-motion-releases-input'])
      assert.equal(result.failure, 'Closing the Category dialog restores its exact original trigger')
      assert.equal(result.observed?.category, 'open')
    }
  } else {
    assert.equal(processResult.exitCode, 0, result.failure)
    assert.equal(result.passed, true, result.failure)
    assert.equal(result.cases.length, 5)
  }
  const images = Object.fromEntries(await Promise.all(result.frames.map(async frame => [frame, digest(await readFile(join(evidence, frame)))])))
  const receipt = join(evidence, 'receipt.json')
  await writeFile(receipt, JSON.stringify({ passed: true, mutation, loaded, layerHash, images, result }, null, 2) + '\n')
  console.log(relative(root, receipt))
} finally {
  await rm(renderer, { recursive: true, force: true })
}
