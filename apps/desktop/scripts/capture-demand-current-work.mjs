import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/demand-current-work')
const evidence = path.join(root, '.tmp/demand-current-work', 'visual-' + globalThis.crypto.randomUUID()), privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-current-demand-visual-'))
const require = createRequire(path.join(desktop, 'package.json')), { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const files = ['src/renderer/src/components/AgentRegionHeader.tsx', 'src/renderer/src/components/RegionCurrentDemand.tsx', 'src/renderer/src/lib/goal-current-work.ts', 'src/renderer/src/styles/region-current-demand.css', 'src/renderer/src/components/GlobalBoardSurface.tsx', 'src/renderer/src/App.tsx', 'scripts/fixtures/demand-current-work/entry.tsx', 'scripts/fixtures/demand-current-work/main.cjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(desktop, file))).digest('hex')])))
await fs.mkdir(evidence, { recursive: true }); let source
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const receipt = { passed: false, evidence, source, independentReview: 'pending', userRunTouched: false }
try {
  const config = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(fixture, 'vitest.config.mts')); assert.ok(config?.config.resolve?.alias)
  // Resolve the newly locked preview engines from the installed pool without changing
  // shared dependency links. Existing Source workspace aliases continue to own the App.
  const manifest = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8')), pool = path.join(root, 'node_modules/.pnpm'), entries = await fs.readdir(pool), aliases = []
  const target = value => typeof value === 'string' ? value : value && target(value.browser ?? value.import ?? value.production ?? value.default)
  receipt.dependencies = {}
  for (const name of ['@viz-js/viz', '@excalidraw/excalidraw', '@plantuml/core', 'pdfjs-dist', 'vega', 'vega-lite', 'vega-interpreter', 'mermaid', 'papaparse', 'prettier', 'smol-toml', 'jsonc-parser', 'tldts', 'dompurify']) {
    const version = manifest.dependencies[name], prefix = name.replaceAll('/', '+') + '@' + version
    assert.ok(version && !version.startsWith('^'), 'Capture requires the exact locked engine: ' + name)
    const matches = entries.filter(entry => entry === prefix || entry.startsWith(prefix + '_')); assert.equal(matches.length, 1, 'Unique installed locked engine: ' + name)
    const directory = path.join(pool, matches[0], 'node_modules', name), descriptor = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(descriptor.version, version); receipt.dependencies[name] = { version, directory }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const [key, value] of Object.entries(descriptor.exports ?? {})) {
      const file = target(value); if (!key.startsWith('./') || key.includes('*') || !file) continue
      aliases.push({ find: new RegExp('^' + (name + key.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: path.resolve(directory, file) })
    }
    aliases.push({ find: new RegExp('^' + escaped + '$'), replacement: path.resolve(directory, target(descriptor.exports?.['.'] ?? descriptor.exports) ?? descriptor.module ?? descriptor.main ?? 'index.js') },
      { find: new RegExp('^' + escaped + '/(.*)$'), replacement: directory + '/$1' })
  }
  config.config.resolve.alias = [...aliases, ...config.config.resolve.alias]
  source = await hashes(); receipt.source = source; await fs.writeFile(path.join(evidence, 'source-hashes.json'), JSON.stringify(source, null, 2) + '\n')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: config.config.resolve, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  const result = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => console.log(line) })
  assert.equal(result.timedOut, false); receipt.render = JSON.parse(await fs.readFile(path.join(evidence, 'render.json'), 'utf8')); assert.equal(result.exitCode, 0, receipt.render.failure?.message); assert.equal(receipt.render.passed, true); assert.equal(receipt.render.frames.length, 28)
  assert.deepEqual(await hashes(), source, 'Current Region visual owner changed during capture'); receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
finally { assert.deepEqual(await listProbeProcesses(-1, privateRoot), []); await fs.rm(privateRoot, { recursive: true, force: true }); await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(JSON.stringify({ passed: receipt.passed, evidence: path.join(evidence, 'receipt.json'), frames: receipt.render?.frames.length, error: receipt.error?.message })); assert.equal(receipt.passed, true, receipt.error?.message)
