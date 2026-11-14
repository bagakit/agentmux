import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { AgentProviderRegistry } from '@agentmux/core'
import { build } from 'vite'
import { runProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const fixture = join(import.meta.dirname, 'fixtures/posture-menu-controls')
const require = createRequire(import.meta.url)
const evidenceRoot = join(root, '.tmp/posture-menu-controls')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'capture-'))
const outDir = join(evidence, 'renderer')
const provider = new AgentProviderRegistry().catalog().find(entry => entry.postureControl)
assert.ok(provider?.postureControl?.modes.length >= 2, 'Core catalog must supply real posture actions')
const mutation = process.argv.includes('--break-return-focus')
const sharedMenu = 'packages/client-ui/src/components/HoverDropdownMenu.tsx'
const menuStyles = 'apps/desktop/src/renderer/src/styles/chrome.css'
const productionChain = [sharedMenu, 'apps/desktop/src/renderer/src/components/PosturePicker.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', menuStyles]
const source = {}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    define: { __POSTURE_PROVIDER__: JSON.stringify(provider), __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'posture-sources', enforce: 'pre',
      transform(code, id) {
        const file = relative(root, id)
        if (!productionChain.includes(file)) return
        source[file] = digest(code)
        if (file !== sharedMenu || !mutation) return
        const statement = 'if (menu.hover.current) event.preventDefault()\n        onCloseAutoFocus?.(event)'
        assert.equal(code.split(statement).length, 2, 'Mutation must match exactly one shared focus handler')
        const mutated = code.replace(statement, 'event.preventDefault()\n        onCloseAutoFocus?.(event)')
        source[file] = digest(mutated)
        return mutated
      },
      async generateBundle() {
        const css = join(root, menuStyles)
        if (this.getWatchFiles().includes(css)) source[menuStyles] = digest(await readFile(css))
      }
    }],
    build: { outDir, emptyOutDir: true, target: 'esnext', reportCompressedSize: false }
  })
  for (const file of productionChain) assert.ok(source[file], 'Real loaded source required: ' + file)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), evidence],
    { temporaryRoot: evidence, cwd: root, env, timeoutMs: 60_000 })
  const result = JSON.parse(await readFile(join(evidence, 'renderer.json'), 'utf8'))
  assert.equal(run.exitConfirmed, true)
  if (mutation) {
    assert.equal(result.passed, false)
    assert.equal(run.exitCode, 1)
    assert.equal(result.failure, 'Escape must return to the original Posture trigger')
  } else {
    assert.equal(result.passed, true, result.failure)
    assert.equal(run.exitCode, 0)
    assert.equal(result.frames.length, 2)
  }
  const receipt = join(evidence, 'receipt.json')
  for (const file of [import.meta.filename, ...['entry.tsx', 'index.html', 'main.cjs'].map(name => join(fixture, name))]) {
    source[relative(root, file)] = digest(await readFile(file))
  }
  const images = Object.fromEntries(await Promise.all(result.frames.map(async frame => [frame, digest(await readFile(join(evidence, frame)))])))
  await writeFile(receipt, JSON.stringify({ passed: true, mutation, source, images, result }, null, 2) + '\n')
  console.log(relative(root, receipt))
} finally {
  await rm(outDir, { recursive: true, force: true })
}
