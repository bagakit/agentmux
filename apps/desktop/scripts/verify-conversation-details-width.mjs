import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), fixture = path.join(import.meta.dirname, 'fixtures/conversation-details-width')
const require = createRequire(path.join(root, 'apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
const temporary = await mkdtemp(path.join(tmpdir(), 'amux-details-width-')), renderer = path.join(temporary, 'renderer')
const output = path.resolve(process.env.AGENTMUX_DETAILS_WIDTH_EVIDENCE ?? path.join(root, '.bagakit/evidence/conversation-details-width'))
await mkdir(renderer); await mkdir(output, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), loaded = {}
const source = { name: 'original-source', setup(builder) {
  builder.onLoad({ filter: /\.(?:tsx?|[cm]?js|css|json)$/, namespace: 'file' }, async args => {
    const bytes = await readFile(args.path), name = path.relative(root, args.path), extension = path.extname(args.path).slice(1)
    if (!name.includes('node_modules/')) loaded[name] = sha(bytes)
    return { contents: bytes.toString(), loader: ['mjs', 'cjs'].includes(extension) ? 'js' : extension }
  })
} }
const assets = { name: 'original-vite-assets', setup(builder) {
  builder.onResolve({ filter: /\?(worker|url)$/ }, args => ({ path: createRequire(args.importer).resolve(args.path.replace(/\?(worker|url)$/, '')), namespace: args.path.endsWith('?worker') ? 'worker' : 'url' }))
  builder.onLoad({ filter: /.*/, namespace: 'url' }, async args => {
    const bytes = await readFile(args.path), name = 'asset-' + sha(bytes).slice(0, 12) + path.extname(args.path)
    await writeFile(path.join(renderer, name), bytes)
    return { contents: `export default new URL('./${name}',import.meta.url).href`, loader: 'js' }
  })
  builder.onLoad({ filter: /.*/, namespace: 'worker' }, async args => {
    const name = 'worker-' + sha(args.path).slice(0, 12) + '.js'
    await build({ entryPoints: [args.path], outfile: path.join(renderer, name), bundle: true, format: 'esm', platform: 'browser', target: 'esnext', plugins: [source], logLevel: 'error' })
    return { contents: `export default class extends Worker { constructor(options){super(new URL('./${name}',import.meta.url),{...options,type:'module'})} }`, loader: 'js' }
  })
} }
try {
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.tsx')], outdir: renderer, entryNames: 'entry',
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true,
    conditions: ['browser', 'production'], plugins: [assets, source], logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    loader: Object.fromEntries(['woff2', 'woff', 'ttf', 'svg', 'png', 'jpg', 'gif'].map(extension => ['.' + extension, 'file'])) })
  for (const name of ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'packages/client-ui/src/components/ConversationInputDetails.tsx', 'packages/client-ui/src/styles/conversation-message.css', 'packages/client-ui/src/styles/conversation-input-details.css']) assert.ok(loaded[name], 'Original compiled consumer ' + name)
  await writeFile(path.join(renderer, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
  await writeFile(path.join(output, 'compile.json'), JSON.stringify({ sourceSha256: loaded, metafile: built.metafile }, null, 2) + '\n')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const outcome = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(renderer, 'index.html'), temporary, path.join(output, 'layout.json')],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 45000, onLine: line => console.error(line) })
  const result = JSON.parse(await readFile(path.join(output, 'layout.json'), 'utf8'))
  for (const [name, hash] of Object.entries(loaded)) assert.equal(sha(await readFile(path.join(root, name))), hash, 'Original source retained after compile ' + name)
  assert.equal(outcome.exitCode, 0, result.failure?.message); assert.equal(result.passed, true); assert.equal(result.scenes.length, 12)
  console.log(JSON.stringify({ passed: true, scenes: result.scenes.length, evidence: path.relative(root, output), visualAcceptance: false }))
} finally { if ((await listProbeProcesses(-1, temporary)).length === 0) await rm(temporary, { recursive: true, force: true }) }
