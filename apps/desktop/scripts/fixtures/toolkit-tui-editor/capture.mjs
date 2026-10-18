import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'

export async function captureToolkitEditor({ evidence, mutation = null }) {
  assert.ok(mutation === null || mutation === 'shell-language', 'Known native editor mutation')
  const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
  const require = createRequire(path.join(root, 'apps/desktop/package.json'))
  const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')))
  const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(fixture, '../settings-overview/vitest.config.mts'), root)
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-toolkit-editor-'))
  await fs.mkdir(evidence, { recursive: true })
  const hash = value => createHash('sha256').update(value).digest('hex')
  const receipt = { passed: false, mutation, inputs: {}, loaded: [], process: null }
  const bind = async file => { const source = await fs.readFile(file); receipt.inputs[path.relative(root, file)] = hash(source) }
  try {
    for (const name of ['capture.mjs', 'entry.tsx', 'main.cjs', 'index.html']) await bind(path.join(fixture, name))
    const plugin = () => ({ name: 'actual-toolkit-editor-inputs', enforce: 'pre', async transform(source, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(root + '/')) return
      await bind(file)
      if (mutation && file.endsWith('/ToolkitScriptEditor.tsx')) {
        const before = "mode === 'tui' ? 'shell' : 'javascript'"
        assert.equal(source.split(before).length, 2, 'Exact native language mutation anchor')
        const loaded = source.replace(before, "mode === 'tui' ? 'plaintext' : 'javascript'")
        receipt.loaded.push({ file: path.relative(root, file), sourceSHA256: hash(source), loadedSHA256: hash(loaded) })
        return { code: loaded, map: null }
      }
    } })
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: config.resolve,
      define: { ...config.define, 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
      plugins: [plugin()], worker: { format: 'es', plugins: () => [plugin()] }, build: { target: 'esnext', outDir: path.join(evidence, 'compiled') } })
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(AGENTMUX|AMUX|CODEX|CTXMUX|BAGAKIT|CLAUDE|OPENAI|ANTHROPIC)_/.test(key)) delete env[key]
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
    env.HOME = path.join(privateRoot, 'home')
    const output = path.join(evidence, 'native.json'), lines = []
    receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(evidence, 'compiled/index.html'), privateRoot, output], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => lines.push(line) })
    await fs.writeFile(path.join(evidence, 'stderr.log'), lines.join('\n'))
    receipt.native = JSON.parse(await fs.readFile(output, 'utf8'))
    assert.equal(receipt.process.timedOut, false)
    if (mutation) {
      assert.notEqual(receipt.process.exitCode, 0); assert.equal(receipt.native.failure?.name, 'AssertionError')
      assert.ok(receipt.loaded.some(item => item.sourceSHA256 !== item.loadedSHA256), 'Native mutant actually loaded')
    } else { assert.equal(receipt.process.exitCode, 0, receipt.native.failure?.message); assert.equal(receipt.native.passed, true) }
    receipt.passed = true
  } finally {
    receipt.remaining = await listProbeProcesses(-1, privateRoot)
    if (!receipt.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.privateRootRemoved = true }
    for (const [file, digest] of Object.entries(receipt.inputs)) assert.equal(hash(await fs.readFile(path.join(root, file))), digest, 'Native source changed: ' + file)
    await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.deepEqual(receipt.remaining, [])
  return receipt
}
