import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'packages/core/package.json'))
const { build } = require('esbuild'), electron = createRequire(join(root, 'apps/desktop/package.json'))('electron')
const evidence = resolve(process.env.AGENTMUX_STARTUP_MEMBER_EVIDENCE ?? join(root, '.local/state/startup-member-observation'))
await mkdir(evidence, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), 'amux-startup-member-')), hash = value => createHash('sha256').update(value).digest('hex')
const loaded = [], aliases = new Map(), receipt = { passed: false, evidence, cases: [], cleanup: null }
for (const name of ['core', 'identity', 'layout', 'demand', 'client-ui', 'relay', 'git', 'diagnostic-evidence']) {
  const directory = join(root, 'packages', name), manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (key.includes('*')) continue
    const target = typeof value === 'string' ? value : value.browser ?? value.import
    if (!target) continue
    const source = resolve(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts'))
    try { await access(source); aliases.set('@agentmux/' + name + (key === '.' ? '' : key.slice(1)), source) } catch { /* Unused generated/asset exports keep their original package resolution. */ }
  }
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const logs = []
try {
  const tests = await runProbeProcess('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.startup-member-observation.config.mts'], {
    cwd: root, env, temporaryRoot: temporary, timeoutMs: 120000, onLine: line => logs.push(line)
  })
  await writeFile(join(evidence, 'core-consumer.log'), logs.splice(0).join('\n'))
  assert.equal(tests.exitCode, 0, 'Actual public Preload/Main/Core consumer suite must pass')
  receipt.coreConsumer = tests
  const focus = await runProbeProcess('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.focus-source-unification.config.mts',
    '-t', 'one real local task|different original Runtimes|ordinary foreign card opens'], {
    cwd: root, env, temporaryRoot: temporary, timeoutMs: 120000, onLine: line => logs.push(line)
  })
  await writeFile(join(evidence, 'focus-consumer.log'), logs.splice(0).join('\n'))
  assert.equal(focus.exitCode, 0, 'Actual GlobalFocusSurface/MemberReader original member consumers must pass')
  receipt.focusConsumer = focus
  for (const mutation of ['baseline', 'raw-signal']) {
    const directory = join(temporary, mutation), caseEvidence = join(evidence, mutation)
    await mkdir(directory); await mkdir(caseEvidence, { recursive: true })
    await symlink(join(root, 'packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
    // Re-running a candidate must not consume a prior failure/result receipt.
    await rm(join(caseEvidence, 'bridge.json'), { force: true }); await rm(join(caseEvidence, 'bridge-failure.json'), { force: true })
    const plugin = { name: 'current-startup-member-bridge', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => aliases.has(args.path) ? { path: aliases.get(args.path) } : undefined)
      builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
        if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
        const original = await readFile(args.path, 'utf8'), path = relative(root, args.path)
        let code = original
        if (mutation === 'raw-signal' && path === 'apps/desktop/src/renderer/src/lib/space-mount-api.ts') {
          const anchor = 'result.call(method, input, cancellation(requestSignal))'
          assert.equal(code.split(anchor).length - 1, 1); code = code.replace(anchor, 'result.call(method, input, requestSignal)')
        }
        if (mutation === 'raw-signal' && path === 'apps/desktop/src/preload/space-mount.ts') {
          const anchor = "const token = mintObjectId(), pending = ipc.invoke('spaceMounts:memberCall', token, memberToken, method, value)"
          assert.equal(code.split(anchor).length - 1, 1); code = code.replace(anchor, 'const signal = context; signal?.throwIfAborted(); ' + anchor)
        }
        loaded.push({ mutation, path, originalSHA256: hash(original), consumedSHA256: hash(code) })
        return { contents: code, loader: args.path.endsWith('.ts') ? 'ts' : 'js' }
      })
    } }
    const shared = { absWorkingDir: root, bundle: true, target: 'es2022', logLevel: 'silent', plugins: [plugin], external: ['electron', '@ctxmux/sdk'],
      nodePaths: ['packages/core/node_modules', 'apps/desktop/node_modules', 'apps/host/node_modules'].map(path => join(root, path)) }
    await build({ ...shared, stdin: { contents: `import {contextBridge,ipcRenderer} from 'electron';import {createPreloadSpaceMount} from './apps/desktop/src/preload/space-mount.ts';contextBridge.exposeInMainWorld('agentmux',{spaceMounts:createPreloadSpaceMount(ipcRenderer)})`, resolveDir: root },
      outfile: join(directory, 'preload.cjs'), platform: 'node', format: 'cjs' })
    await build({ ...shared, entryPoints: [join(root, 'apps/desktop/scripts/fixtures/startup-member-observation/main.ts')], outfile: join(directory, 'main.mjs'), platform: 'node', format: 'esm',
      banner: { js: "import { createRequire as privateRequire } from 'node:module'; const require = privateRequire(import.meta.url);" } })
    await build({ ...shared, stdin: { contents: `import {createRendererSpaceMount} from './apps/desktop/src/renderer/src/lib/space-mount-api.ts';window.memberBridge={createRendererSpaceMount}`, resolveDir: root },
      outfile: join(directory, 'renderer.js'), platform: 'browser', format: 'iife' })
    const execution = await runProbeProcess(electron, [join(directory, 'main.mjs'), directory, caseEvidence], {
      cwd: root, env, temporaryRoot: temporary, timeoutMs: 30000, onLine: line => logs.push(line)
    })
    await writeFile(join(caseEvidence, 'process.log'), logs.splice(0).join('\n'))
    if (mutation === 'baseline') {
      assert.equal(execution.exitCode, 0, 'Actual sandboxed member bridge must pass')
      const result = JSON.parse(await readFile(join(caseEvidence, 'bridge.json'), 'utf8'))
      assert.equal(result.passed, 4); receipt.cases.push({ mutation, execution, result })
    } else {
      assert.notEqual(execution.exitCode, 0, 'Restoring raw AbortSignal across contextBridge must fail')
      const failure = JSON.parse(await readFile(join(caseEvidence, 'bridge-failure.json'), 'utf8'))
      assert.equal(failure.passed, 0); assert.match(failure.message, /Original member read.*throwIfAborted.*not a function/s)
      assert.ok(loaded.filter(value => value.mutation === mutation && value.originalSHA256 !== value.consumedSHA256).length >= 2)
      receipt.cases.push({ mutation, execution, failure })
    }
    console.log(mutation + ': ' + (mutation === 'baseline' ? '4 actual isolated bridge cases passed' : 'exact screenshot TypeError reproduced'))
  }
  for (const file of loaded) assert.equal(hash(await readFile(join(root, file.path))), file.originalSHA256, 'Loaded production source stayed unchanged')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'loaded-source.jsonl'), loaded.map(value => JSON.stringify(value)).join('\n') + '\n')
  const remaining = await listProbeProcesses(-1, temporary)
  receipt.cleanup = { temporary, remaining, removed: false, evidencePreserved: evidence }
  if (!remaining.length) { await rm(temporary, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence, failure: receipt.failure?.message, cleanup: receipt.cleanup.removed }))
}
