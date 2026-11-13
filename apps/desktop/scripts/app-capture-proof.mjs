import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { runProbeProcess } from './probe-process.mjs'
import { fixturePath } from './lib/fixture-values.mjs'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'packages/core/package.json'))
const { build } = require('esbuild')
const electron = createRequire(join(root, 'apps/desktop/package.json'))('electron')
const core = join(root, 'packages/core')
const exports = JSON.parse(await readFile(join(core, 'package.json'), 'utf8')).exports
const source = subpath => {
  const mapping = exports[subpath]
  const imported = typeof mapping === 'string' ? mapping : mapping?.import
  assert.ok(imported, `The public Core subpath must exist: ${subpath}`)
  return join(core, imported.replace(/^\.\/dist\/src\//, 'src/').replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))
}

/** Compile an immutable private candidate, then exercise its real Electron/RPC/CLI chain. */
export async function runAppCaptureProof({ entry, mutation, extraEntries = {}, label = 'capture' }) {
  const temporary = await mkdtemp(fixturePath('tmp/amx-capture-'))
  const evidence = join(root, '.local/bootstrap-capture', label)
  await mkdir(evidence, { recursive: true })
  await appendFile(join(evidence, 'probe-roots.jsonl'), JSON.stringify({root:temporary,entry,mutation:mutation?.file ?? null}) + '\n')
  const outputs = join(temporary, 'compiled')
  await mkdir(outputs, { recursive: true })
  const inputs = new Map()
  const workspaces = new Set()
  const plugin = { name: 'original-capture-source', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\/[^/]+(?:\/.*)?$/ }, async args => {
      const parts = args.path.split('/'), name = parts[1], subpath = parts.length === 2 ? '.' : './' + parts.slice(2).join('/')
      const directory = join(root, name === 'host' || name === 'mobile' ? 'apps' : 'packages', name)
      workspaces.add(directory)
      const manifestPath = join(directory, 'package.json'), manifestText = await readFile(manifestPath, 'utf8')
      inputs.set(manifestPath, createHash('sha256').update(manifestText).digest('hex'))
      const manifest = JSON.parse(manifestText)
      const mapping = manifest.exports?.[subpath] ?? (subpath === '.' ? manifest.main : null)
      const imported = typeof mapping === 'string' ? mapping : mapping?.import ?? mapping?.default
      assert.ok(imported, 'Workspace export must exist: ' + args.path)
      let candidate = join(directory, imported.replace(/^\.\/dist\/src\//, 'src/').replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))
      try { await readFile(candidate) } catch {
        candidate = candidate.replace(/\.ts$/, '.tsx')
        try { await readFile(candidate) } catch {
          // Generated workspace payloads have no same-named TS entry. Bundle their
          // exact existing bytes now; a later worker never follows a mutable dist.
          candidate = join(directory, imported); await readFile(candidate)
        }
      }
      return { path: candidate }
    })
    builder.onLoad({ filter: /\.[cm]?[tj]sx?$/ }, async args => {
      let contents = await readFile(args.path, 'utf8')
      inputs.set(args.path, createHash('sha256').update(contents).digest('hex'))
      if (mutation && args.path.endsWith(mutation.file)) {
        assert.ok(contents.includes(mutation.before), `Mutation must change a real source branch: ${mutation.file}`)
        contents = contents.replace(mutation.before, mutation.after)
      }
      return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(args.path) }
    })
  } }
  const options = { bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
    external: ['electron'], plugins: [plugin], logLevel: 'silent', sourcemap: false }
  await build({ ...options, entryPoints: [entry], outfile: join(outputs, 'main.mjs') })
  await build({ ...options, entryPoints: [join(core, 'src/agentmux.ts')], outfile: join(outputs, 'cli.mjs') })
  await build({ ...options, entryPoints: [join(core, 'src/control-endpoint-listener-worker.ts')], outfile: join(outputs, 'control-endpoint-listener-worker.js') })
  for (const [name, path] of Object.entries(extraEntries)) await build({ ...options, entryPoints: [path], outfile: join(outputs, `${name}.mjs`) })
  // External mature dependencies remain shared; no product dist or installed App is rewritten.
  const { symlink, readdir } = await import('node:fs/promises')
  const linked = new Set()
  const modules = join(temporary, 'node_modules'); await mkdir(modules)
  for (const origin of [join(root, 'apps/desktop/node_modules'), join(core, 'node_modules'), join(root, 'node_modules'), ...[...workspaces].map(directory => join(directory, 'node_modules'))]) {
    const entries = await readdir(origin, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const item of entries) {
      if (item.name.startsWith('@') && item.isDirectory()) {
        await mkdir(join(modules, item.name), { recursive: true })
        for (const child of await readdir(join(origin, item.name))) {
          const key = item.name + '/' + child
          if (!linked.has(key)) { await symlink(join(origin, key), join(modules, key), 'dir'); linked.add(key) }
        }
      } else if (!linked.has(item.name)) { await symlink(join(origin, item.name), join(modules, item.name), 'dir'); linked.add(item.name) }
    }
  }
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
  const userData = join(temporary, 'profile'), runtimeRoot = join(temporary, 'runtime'), resultPath = join(temporary, 'result.json')
  const environment = privatePackageSmokeEnvironment(process.env, { userData, runtimeRoot, readyFile: join(temporary, 'ready.json') })
  for (const directory of [environment.HOME, environment.TMPDIR, userData, join(userData, 'appData'), join(userData, 'sessionData')]) await mkdir(directory, { recursive: true })
  delete environment.AGENTMUX_DESKTOP_EXIT_AFTER_READY
  Object.assign(environment, { AGENTMUX_CAPTURE_PROOF_ROOT: temporary, AGENTMUX_CAPTURE_PROOF_RESULT: resultPath,
    AGENTMUX_CAPTURE_PROOF_CLI: join(outputs, 'cli.mjs') })
  if (extraEntries.recovery) environment.AGENTMUX_RECORDING_RECOVERY_ENTRY = join(outputs, 'recovery.mjs')
  const launcher = join(temporary, 'launch.cjs')
  await writeFile(launcher, `const {app}=require('electron');const p=require('node:path');
    app.setPath('home',process.env.HOME);app.setPath('appData',p.join(${JSON.stringify(userData)},'appData'));
    app.setPath('userData',${JSON.stringify(userData)});app.setPath('sessionData',p.join(${JSON.stringify(userData)},'sessionData'));
    import(${JSON.stringify(new URL('file:' + join(outputs, 'main.mjs')).href)}).catch(e=>{console.error(e);app.exit(1)});`)
  let report, completed = false
  const logs = []
  try {
    const processResult = await runProbeProcess(electron, [launcher], { env: environment, cwd: root, timeoutMs: 90_000, onLine: line => { logs.push(line); if (logs.length > 2000) logs.shift(); process.stderr.write(line + '\n') } })
    try { report = JSON.parse(await readFile(resultPath, 'utf8')) }
    catch { throw new Error(`Capture proof did not return a receipt: ${JSON.stringify(processResult)}`) }
    if (!report.passed) {
      await writeFile(join(evidence, 'failure.json'), JSON.stringify(report, null, 2))
      const error = new Error(report.error ?? JSON.stringify(processResult)); error.proofReport = report; throw error
    }
    for (const [file, digest] of inputs) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), digest, 'The loaded candidate changed while proving it')
    report.source = Object.fromEntries([...inputs].map(([file, digest]) => [file.slice(root.length + 1), digest]))
    report.mutation = mutation ? { file: mutation.file, changed: true } : null
    if (report.png) { await writeFile(join(evidence, 'frame.png'), Buffer.from(report.png, 'base64')); delete report.png }
    if (report.webm) { await writeFile(join(evidence, 'clip.webm'), Buffer.from(report.webm, 'base64')); delete report.webm }
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
    completed = true
    return { ...report, evidence }
  } finally {
    await writeFile(join(evidence, 'native.log'), logs.join('\n'))
    if (completed) await rm(temporary, { recursive: true, force: true })
    else await writeFile(join(evidence, 'retained-private-root.txt'), temporary + '\n')
  }
}
