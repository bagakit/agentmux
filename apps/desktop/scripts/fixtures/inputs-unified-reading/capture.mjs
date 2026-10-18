import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '../../../../..'), fixture = import.meta.dirname
const artifactRoot = path.join(root, '.bagakit/feature-tracker/inputs-unified-reading/native')
const tag = process.argv.find(arg => arg.startsWith('--tag='))?.slice(6) ?? new Date().toISOString().replace(/[:.]/g, '-')
assert.match(tag, /^[a-zA-Z0-9_-]+$/)
const evidence = path.join(artifactRoot, tag), out = path.join(evidence, 'compiled')
await fs.mkdir(out, { recursive: true })
const require = createRequire(path.join(root, 'apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
const hash = value => createHash('sha256').update(value).digest('hex'), loaded = new Map()
const packages = new Map(await Promise.all(['core', 'client-ui', 'layout', 'demand'].map(async name => [name,
  JSON.parse(await fs.readFile(path.join(root, 'packages', name, 'package.json'), 'utf8')).exports])))
const sourcePlugin = { name: 'current-product-source', setup(ctx) {
  ctx.onResolve({ filter: /\?(worker|url)$/ }, async args => {
    const kind = args.path.split('?').at(-1)
    const resolved = await ctx.resolve(args.path.replace(/\?(worker|url)$/, ''), { resolveDir: args.resolveDir, kind: 'import-statement' })
    if (resolved.errors.length) return { errors: resolved.errors }
    return { path: resolved.path, namespace: 'private-bundler-asset', pluginData: { kind } }
  })
  ctx.onLoad({ filter: /.*/, namespace: 'private-bundler-asset' }, async args => {
    const file = 'worker-' + hash(args.path).slice(0, 12) + '.js'
    if (args.pluginData.kind === 'worker') await build({ entryPoints: [args.path], outfile: path.join(out, file), bundle: true, platform: 'browser', format: 'esm', logLevel: 'error' })
    else await fs.copyFile(args.path, path.join(out, file))
    return { contents: args.pluginData.kind === 'worker'
      ? `export default class extends Worker { constructor(options) { super(new URL(${JSON.stringify(file)}, import.meta.url), { ...options, type: 'module' }) } }`
      : `export default new URL(${JSON.stringify(file)}, import.meta.url).href`, loader: 'js' }
  })
  ctx.onResolve({ filter: /^@agentmux\/(core|client-ui|layout|demand)(\/.*)?$/ }, args => {
    const [, name, suffix = ''] = args.path.match(/^@agentmux\/([^/]+)(.*)$/), exports = packages.get(name)
    const key = suffix ? '.' + suffix : '.', match = Object.keys(exports).find(candidate => candidate === key)
      ?? Object.keys(exports).filter(candidate => candidate.includes('*')).sort((a, b) => b.length - a.length).find(candidate => key.startsWith(candidate.split('*')[0]) && key.endsWith(candidate.split('*')[1]))
    if (!match) throw new Error('Missing current source export: ' + args.path)
    const entry = exports[match], value = typeof entry === 'string' ? entry : entry.browser ?? entry.import ?? entry.default
    const star = match.includes('*') ? key.slice(match.indexOf('*'), key.length - match.split('*')[1].length) : ''
    let target = value.replace('*', star).replace('./dist/', './src/').replace('./src/src/', './src/')
    if (/\.js$/.test(target)) target = target.replace(/\.js$/, '.ts')
    return { path: path.join(root, 'packages', name, target) }
  })
  ctx.onLoad({ filter: /\.[cm]?[jt]sx?$|\.css$/ }, async args => {
    if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
    const bytes = await fs.readFile(args.path), ext = path.extname(args.path)
    loaded.set(path.relative(root, args.path), { sha256: hash(bytes), bytes: bytes.length })
    return { contents: bytes, loader: ext === '.css' ? 'css' : ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : 'js', resolveDir: path.dirname(args.path) }
  })
} }
const result = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.tsx')], outdir: out,
  bundle: true, format: 'esm', platform: 'browser', conditions: ['browser', 'production'], target: 'esnext', jsx: 'automatic', metafile: true,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.gif': 'file' },
  plugins: [sourcePlugin], logLevel: 'warning' })
await fs.copyFile(path.join(fixture, 'index.html'), path.join(out, 'index.html'))
const required = ['packages/core/src/session-inputs.ts', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'packages/client-ui/src/styles/composer.css']
for (const file of required) assert.ok(loaded.has(file), 'Actual current product source loaded: ' + file)
const manifest = { schema: 'agentmux.inputs-unified-reading-native-build.v1', createdAt: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  loaded: Object.fromEntries(loaded), metafile: result.metafile,
  harness: Object.fromEntries(await Promise.all(['entry.tsx', 'index.html', 'capture.mjs', 'main.cjs'].map(async file =>
    [file, hash(await fs.readFile(path.join(fixture, file)))]))),
  compiled: Object.fromEntries(await Promise.all((await fs.readdir(out)).map(async file =>
    [file, hash(await fs.readFile(path.join(out, file)))]))),
  captureOnly: true, aestheticReview: 'not-performed',
  boundary: 'Current production AgentSessionComposer, SessionMailbox, client-ui CSS and Core projector compiled from source. Explicit private synthetic original pages replace read APIs. Copy records the exact original text; Fill uses the actual Composer. Separate Electron userData; no user application, Runtime, Session or Provider is contacted.' }
await fs.writeFile(path.join(evidence, 'compiled-inputs.json'), JSON.stringify(manifest, null, 2) + '\n')
if (!process.argv.includes('--build-only')) {
  const electron = require('electron'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [path.join(fixture, 'main.cjs'), path.join(out, 'index.html'), evidence,
    ...(process.argv.includes('--smoke') ? ['smoke'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
  const code = await new Promise(resolve => child.once('exit', resolve)); clearTimeout(timer)
  await fs.writeFile(path.join(evidence, 'process.log'), log)
  assert.equal(code, 0, log)
}
console.log(JSON.stringify({ evidence, loaded: loaded.size, buildOnly: process.argv.includes('--build-only') }))
