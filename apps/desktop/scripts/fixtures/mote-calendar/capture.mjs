import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../probe-process.mjs'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'

const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const directory = path.join(root, '.local/state/mote-workspace/capture-' + randomUUID()), compiled = path.join(directory, 'compiled')
// Clear before loading esbuild: its service is a child process too.
for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key]
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: path.join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(directory, 'state'),
  AGENT_SESSION_STORE: path.join(directory, 'store', 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(directory, 'queue', 'private-messages.ndjson') })
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Current MoteFilesTool/MoteProfilePopover/MoteDetailsPanel and AgentSessionComposer, real DesktopClientUiProvider/CSS/theme/icons. Only private outer Space shell, static conversation prose and typed in-memory API replies are synthetic. No user App, preload, journal, schedule, real Session/Run, model, native scheduler, package or install claim.' }
await fs.mkdir(compiled, { recursive: true })
for (const name of ['userData', 'runtime', 'state', 'store', 'queue', 'workspace']) await fs.mkdir(path.join(directory, name), { recursive: true })
try {
  const alias = { ...radixOverlayAliases }, workerInputs = {}
  const consumed = new Map()
  const readBound = async file => {
    const bytes = await fs.readFile(file), hash = sha(bytes), original = consumed.get(file)
    assert.ok(!original || original === hash, 'An input changed during compilation: ' + path.relative(root, file))
    consumed.set(file, hash); return bytes
  }
  const runnerInputs = ['capture.mjs', 'renderer-main.cjs', 'README.md'].map(file => path.join(fixture, file))
  for (const file of [...runnerInputs, path.join(root, 'apps/desktop/package.json'), path.join(root, 'apps/desktop/scripts/probe-process.mjs'), path.join(root, 'apps/desktop/scripts/radix-overlay-aliases.ts')]) await readBound(file)
  const loaders = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.json': 'json', '.css': 'css',
    '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }
  const captureInputs = { name: 'capture-actual-input-bytes', setup(plugin) {
    plugin.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
      const contents = await readBound(args.path), loader = loaders[path.extname(args.path)]
      assert.ok(loader, 'An actual input needs its original esbuild loader: ' + args.path)
      return { contents, loader, resolveDir: path.dirname(args.path) }
    })
  } }
  const clientFolder = path.join(root, 'packages/client-ui')
  const exports = Object.entries(JSON.parse((await readBound(path.join(clientFolder, 'package.json'))).toString('utf8')).exports)
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  const clientSources = { name: 'current-client-ui-source', setup(plugin) {
    plugin.onResolve({ filter: /^@agentmux\/client-ui(?:\/.*)?$/ }, args => {
      const subpath = args.path === '@agentmux/client-ui' ? '.' : '.' + args.path.slice('@agentmux/client-ui'.length)
      for (const [key, target] of exports) {
        const [prefix, suffix = ''] = key.split('*')
        if (key.includes('*') ? !subpath.startsWith(prefix) || !subpath.endsWith(suffix) : subpath !== key) continue
        const source = typeof target === 'string' ? target : target.browser
        assert.ok(source?.startsWith('./src/'), 'Actual browser source export is required')
        return { path: path.join(clientFolder, source.replace('*', subpath.slice(prefix.length, suffix ? -suffix.length : undefined))) }
      }
      throw new Error('Missing current client-ui source: ' + subpath)
    })
  } }
  const workers = { name: 'current-asset-workers', setup(plugin) {
    plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'original-raw' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-raw' }, async args => { workerInputs[args.path] = {}; return { loader: 'js', contents: 'export default ' + JSON.stringify((await readBound(args.path)).toString('utf8')) } })
    plugin.onResolve({ filter: /\?url$/ }, args => ({ path: require.resolve(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => { workerInputs[args.path] = {}; return { loader: 'file', contents: await readBound(args.path) } })
    plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'silent', plugins: [captureInputs] })
      Object.assign(workerInputs, output.metafile.inputs)
      return { loader: 'js', contents: `export default class OriginalMonacoWorker extends Worker {constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(output.outputFiles[0].text)}],{type:'text/javascript'})))}}` }
    })
  } }
  const generatedIdentity = { name: 'generated-identity-source-boundary', setup(plugin) {
    plugin.onResolve({ filter: /^@agentmux\/identity\/runtime-source$/ }, () => {
      throw new Error('Generated identity runtime source requires a build-qualified consumer fixture')
    })
  } }
  for (const name of ['core', 'layout', 'demand', 'identity']) {
    const folder = path.join(root, 'packages', name), manifest = JSON.parse((await readBound(path.join(folder, 'package.json'))).toString('utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath.includes('*') || name === 'identity' && subpath === './runtime-source') continue
      const source = name === 'identity' && subpath === './runtime' ? './src/runtime-entry.ts'
        : target.import.replace('./dist/', ['core', 'identity'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts')
      alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(folder, source)
    }
  }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.tsx')], outdir: compiled, bundle: true,
    format: 'esm', platform: 'browser', conditions: ['browser', 'production'], target: 'esnext', jsx: 'automatic', logLevel: 'silent', metafile: true, alias, plugins: [generatedIdentity, clientSources, workers, captureInputs],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  const inputs = Object.keys({ ...built.metafile.inputs, ...workerInputs }).filter(file => !/^original-(worker|url|raw):/.test(file))
  for (const file of inputs) assert.ok(consumed.has(path.resolve(root, file)), 'Metafile input has no actual source-byte binding: ' + file)
  receipt.source = Object.fromEntries([...consumed].map(([file, hash]) => [path.relative(root, file), hash]))
  receipt.compiler = { esbuild: createRequire(require.resolve('vite'))('esbuild').version, sourceBinding: 'actual-onLoad-bytes', currentSource: true, standardCoreBuild: false }
  for (const file of ['MoteFilesTool', 'MoteProfilePopover', 'MoteDetailsPanel', 'MoteCalendar', 'AgentSessionComposer', 'DesktopClientUiProvider'])
    assert.ok(receipt.source['apps/desktop/src/renderer/src/components/' + file + '.tsx'], 'Nonempty actual product input: ' + file)
  await fs.writeFile(path.join(directory, 'compile-inputs.json'), JSON.stringify(built.metafile, null, 2))
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script type="module" src="entry.js"></script></body></html>')
  receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: path.join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(directory, 'state'),
    AGENT_SESSION_STORE: path.join(directory, 'store', 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(directory, 'queue', 'private-messages.ndjson') })
  receipt.isolation = { inheritedPrefixesCleared: ['AGENTMUX_', 'CTXMUX_'], electronRunAsNodeCleared: true,
    paths: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('AGENTMUX_') || key === 'AGENT_SESSION_STORE')), userData: path.join(directory, 'userData'), preload: false }
  const executable = require('electron')
  receipt.engine = { executable, sha256: sha(await fs.readFile(executable)), version: require('electron/package.json').version,
    override: process.env.ELECTRON_OVERRIDE_DIST_PATH ?? null }
  const logs = []
  receipt.process = await runProbeProcess(executable, [path.join(fixture, 'renderer-main.cjs'), path.join(compiled, 'index.html'), directory],
    { cwd: root, env, timeoutMs: 120_000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n') + '\n')
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  receipt.evidence = Object.fromEntries(await Promise.all(['renderer.log', 'renderer-result.json', 'compile-inputs.json'].map(async file => [file, sha(await fs.readFile(path.join(directory, file)))])))
  receipt.sourceDrift = []
  for (const [file, expected] of Object.entries(receipt.source)) if (sha(await fs.readFile(path.resolve(root, file))) !== expected) receipt.sourceDrift.push(file)
  assert.deepEqual(receipt.sourceDrift, [], 'Actual capture inputs drifted; recapture the final candidate')
  receipt.passed = true
} catch (error) {
  receipt.error = { message: error.message, stack: error.stack, ...(error.probe ? { process: error.probe } : {}) }
} finally {
  await fs.rm(compiled, { recursive: true, force: true })
  receipt.compiledRemoved = true
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error?.message.split('\n')[0]); process.exitCode = 1 }
