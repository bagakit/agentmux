import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, relative } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { build as vite } from 'vite'
import { spawn } from 'node:child_process'

// Fixture-only lifecycle: the original ChildProcess is the sole signal target.
// No descendant, PID-discovery, process-name or command-line authority exists.
async function runOriginalElectron(command, args, options) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const outcome = { originalPid: child.pid ?? null, exitConfirmed: false, exitCode: null, exitSignal: null, timedOut: false, interruption: null, signals: [] }
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => options.onLine(chunk.toString()))
  return await new Promise((resolve, reject) => {
    let settled = false, hardStop, unknownStop
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout); clearTimeout(hardStop); clearTimeout(unknownStop)
      process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm)
      if (!outcome.exitConfirmed && outcome.originalPid !== null) {
        child.unref(); child.stdout?.destroy(); child.stderr?.destroy()
      }
      if (error) { error.originalProcess = outcome; reject(error) } else resolve(outcome)
    }
    const signalOriginal = signal => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return
      try { outcome.signals.push({ signal, accepted: child.kill(signal) }) }
      catch (error) { outcome.signals.push({ signal, accepted: false, error: error.message }) }
    }
    const stopOriginal = () => {
      if (settled || unknownStop) return
      signalOriginal('SIGTERM')
      hardStop = setTimeout(() => signalOriginal('SIGKILL'), 5000)
      unknownStop = setTimeout(() => finish(), 10000)
    }
    const onSigint = () => { outcome.interruption = 'SIGINT'; stopOriginal() }
    const onSigterm = () => { outcome.interruption = 'SIGTERM'; stopOriginal() }
    const timeout = setTimeout(() => { outcome.timedOut = true; stopOriginal() }, options.timeoutMs)
    process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm)
    child.once('error', finish)
    child.once('exit', (code, signal) => {
      outcome.exitConfirmed = true; outcome.exitCode = code; outcome.exitSignal = signal
      finish()
    })
  })
}

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixtureName = process.argv[2] ?? 'message-control-receipt'
assert.ok(['message-control-receipt', 'durable-input-wait'].includes(fixtureName), 'An explicit original fixture scope is required')
const fixture = join(desktop, 'scripts/fixtures', fixtureName), require = createRequire(import.meta.url)
const { build: esbuild } = require(require.resolve('esbuild', { paths: [join(root, 'packages/core')] }))
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-message-receipt-'))
const evidence = join(root, '.tmp/message-control-receipt', 'attempt-' + randomUUID()), compiled = join(evidence, 'compiled')
await mkdir(compiled, { recursive: true }); await mkdir(join(privateRoot, 'user-data')); await mkdir(join(privateRoot, 'session-data')); await mkdir(join(privateRoot, 'runtime'))
const privateIdentity = await lstat(privateRoot, { bigint: true })
const pins = {}, sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bind = async file => { const bytes = await readFile(file); pins[relative(root, file)] = sha(bytes); return bytes }
const aliases = new Map()
for (const name of ['core', 'demand', 'layout', 'identity', 'relay', 'client-ui', 'git', 'diagnostic-evidence']) {
  const directory = join(root, 'packages', name), pkg = JSON.parse(await bind(join(directory, 'package.json')))
  for (const [key, value] of Object.entries(pkg.exports ?? { '.': pkg.main })) {
    const target = typeof value === 'string' ? value.browser ?? value : value.browser ?? value.import
    aliases.set('@agentmux/' + name + (key === '.' ? '' : key.slice(1)), join(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')))
  }
}
const entries = [...aliases].sort(([a], [b]) => b.length - a.length)
const resolveAlias = name => {
  if (aliases.has(name)) return aliases.get(name)
  for (const [pattern, target] of entries) if (pattern.includes('*')) {
    const [prefix, suffix] = pattern.split('*')
    if (name.startsWith(prefix) && name.endsWith(suffix)) return target.replace('*', name.slice(prefix.length, suffix ? -suffix.length : undefined))
  }
}
await symlink(join(desktop, 'node_modules'), join(compiled, 'node_modules'), 'dir')
await symlink(join(root, 'packages/core/node_modules'), join(evidence, 'node_modules'), 'dir')
await symlink(join(root, 'packages/core/vendor'), join(evidence, 'vendor'), 'dir')
const receipt = { privateDirectory: { path: privateRoot, dev: String(privateIdentity.dev), ino: String(privateIdentity.ino) }, passed: false, userRunTouched: false, sourceInputs: pins, rendererTransforms: {}, compiled: {}, evidence }
try {
  for (const [input, output, format] of [
    [join(fixture, 'owner.ts'), join(compiled, 'owner.mjs'), 'esm'],
    [join(desktop, 'src/preload/index.ts'), join(compiled, 'preload.cjs'), 'cjs'],
    [join(root, 'packages/core/src/agentmux.ts'), join(compiled, 'agentmux.mjs'), 'esm']
  ]) {
    await esbuild({ entryPoints: [input], outfile: output, bundle: true, platform: 'node', format, target: 'node24', logLevel: 'error',
      plugins: [{ name: 'actual-node-Source', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\// }, args => { const target = resolveAlias(args.path); return target ? { path: target } : undefined })
        builder.onResolve({ filter: /^[^./]/ }, args => {
          if (isBuiltin(args.path) || args.path === 'electron') return { path: args.path, external: true }
          if (resolveAlias(args.path)) return
          if (args.path === '@ctxmux/sdk') return { path: join(root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js'), external: true }
          if (args.path === 'ws') return { path: join(dirname(require.resolve('ws', { paths: [desktop] })), 'wrapper.mjs'), external: format !== 'cjs' }
          return { path: require.resolve(args.path, { paths: [dirname(args.importer), desktop, join(root, 'packages/core')] }), external: format !== 'cjs' }
        })
        builder.onLoad({ filter: /\.[cm]?tsx?$/ }, async args => {
          if (!args.path.startsWith(root + '/apps/') && !args.path.startsWith(root + '/packages/')) return
          return { contents: (await bind(args.path)).toString(), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
        })
      } }] })
    receipt.compiled[relative(evidence, output)] = sha(await readFile(output))
  }
  const out = join(compiled, 'renderer')
  await vite({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: entries.map(([name, replacement]) => ({ find: new RegExp('^' + name.split('*').map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$'), replacement: replacement.replace('*', '$1') })) },
    plugins: [{ name: 'actual-Renderer-Source', async transform(source, file) {
      if ((file.startsWith(root + '/apps/') || file.startsWith(root + '/packages/')) && !file.includes('?')) {
        await bind(file)
        receipt.rendererTransforms[relative(root, file)] = sha(source)
      }
    } }],
    build: { outDir: out, emptyOutDir: true } })
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name)
      receipt.compiled[relative(evidence, file)] = sha(await readFile(file))
    }
  }
  assert.ok(Object.keys(receipt.compiled).some(file => file.startsWith('compiled/renderer/assets/') && file.endsWith('.js')), 'Actual compiled Renderer graph is nonempty')
  await bind(join(fixture, 'main.cjs')); await bind(join(fixture, 'index.html')); await bind(new URL(import.meta.url).pathname)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.sqlite'), AGENTMUX_RECEIPT_NODE: process.execPath })
  const lines = []
  receipt.outcome = await runOriginalElectron(require('electron'), [join(fixture, 'main.cjs'), join(out, 'index.html'), join(compiled, 'owner.mjs'),
    join(compiled, 'preload.cjs'), join(compiled, 'agentmux.mjs'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env,
    timeoutMs: 60000, onLine: line => lines.push(line) })
  await writeFile(join(evidence, 'process.log'), lines.join('\n'))
  receipt.product = JSON.parse(await readFile(join(evidence, 'product.json')))
  assert.equal(receipt.outcome.exitConfirmed, true); assert.equal(receipt.outcome.timedOut, false); assert.equal(receipt.outcome.interruption, null)
  assert.equal(receipt.product.passed, true, JSON.stringify(receipt.product.failure)); assert.equal(receipt.outcome.exitCode, 0); assert.equal(receipt.outcome.exitSignal, null)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.originalProcess ? { originalProcess: error.originalProcess } : {}) } }
finally {
  if (!receipt.outcome && !receipt.failure?.originalProcess || receipt.outcome?.exitConfirmed === true) {
    try {
      const current = await lstat(privateRoot, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== privateIdentity.dev || current.ino !== privateIdentity.ino) {
        receipt.cleanup = { status: 'retained', reason: 'original-directory-identity-unconfirmed' }
        receipt.passed = false
      } else {
        await rm(privateRoot, { recursive: true, force: false })
        receipt.cleanup = { status: 'removed-original-directory', dev: String(current.dev), ino: String(current.ino) }
      }
    } catch (error) {
      receipt.cleanup = { status: 'retained-or-unconfirmed', error: error.message }
      receipt.passed = false
    }
  } else receipt.cleanup = { status: 'retained', reason: 'original-process-exit-unconfirmed' }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.product?.cases.length ?? 0, receipt: join(evidence, 'receipt.json'), failure: receipt.product?.failure ?? receipt.failure }))
if (!receipt.passed) process.exitCode = 1
