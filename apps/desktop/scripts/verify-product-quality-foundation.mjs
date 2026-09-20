import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repo = resolve(desktop, '../..')
const require = createRequire(import.meta.url), ts = require('typescript')
const mode = process.argv.includes('--source') ? 'source' : process.argv.includes('--native') ? 'native' : undefined
assert.ok(mode, 'Choose --source or --native; neither mode operates the user App or system screenshot selector')
const specifiedEvidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice('--evidence='.length)
const evidence = specifiedEvidence ? resolve(specifiedEvidence) : join(repo, '.tmp', `product-quality-foundation-${mode}-${Date.now()}`)
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const own = [
  'components/ServiceWindowNotice.tsx', 'components/TerminalServiceNotices.tsx', 'components/TerminalView.tsx',
  'components/ContinuousProgressControl.tsx', 'styles/agent.css', 'styles/terminal.css', 'styles/agent-region-header.css',
  'components/AgentLifecycleFeedback.tsx', 'components/SessionPane.tsx'
].map(name => 'apps/desktop/src/renderer/src/' + name)
const focused = ['product-quality-foundation.test.tsx', 'service-window-notice-component.test.tsx', 'agent-region-identity-menu.test.tsx',
  'session-pane-composer.test.tsx', 'continuous-progress-product.test.tsx', 'composer-local-feedback.test.tsx', 'composer-paste-selection.test.tsx']
const inputs = [...own, ...focused.map(name => 'apps/desktop/test/' + name), relative(repo, import.meta.filename),
  ...['entry.tsx', 'index.html', 'main.cjs'].map(name => 'apps/desktop/scripts/fixtures/product-quality-foundation/' + name)]
async function hashes(files) { return Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(repo, file)))]))) }
const result = { schema: 'agentmux.product-quality-foundation-ui-proof.v1', mode, passed: false,
  qualification: mode === 'source' ? 'Actual mounted React consumers; controlled API boundary; not installed App acceptance'
    : 'Private Electron actual production components/CSS/xterm; synthetic preview API facts; not actual Core or user installation',
  userAppTouched: false, permissionsTouched: false, systemScreenshotCalls: 0, inputs: await hashes(inputs), artifacts: {} }
async function artifact(name, content) {
  const file = join(evidence, name); await writeFile(file, content)
  result.artifacts[relative(repo, file)] = sha(content); return relative(repo, file)
}
function runTests(files, cwd = repo) {
  const args = ['--filter', '@agentmux/desktop', 'exec', 'vitest', 'run', ...files.map(name => 'test/' + name), '--maxWorkers=1']
  const execution = spawnSync('pnpm', args, { cwd, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  return { exit: execution.status, log: execution.stdout + execution.stderr, command: 'pnpm_config_verify_deps_before_run=false ' + ['pnpm', ...args].join(' '), error: execution.error?.message }
}
function positive(log) { assert.match(log, /Tests\s+[^\n]*\b[1-9]\d*\s+passed/); assert.match(log, /product-quality-foundation\.test\.tsx/) }
async function callers() {
  const symbols = new Map([
    ['ServiceWindowNotice', 'components/ServiceWindowNotice.tsx'],
    ['TerminalServiceNotices', 'components/TerminalServiceNotices.tsx'],
    ['ContinuousProgressControl', 'components/ContinuousProgressControl.tsx']
  ]), found = Object.fromEntries([...symbols.keys()].map(symbol => [symbol, []]))
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.name.endsWith('.tsx')) {
        const text = await readFile(path, 'utf8'), source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        function visit(node) {
          if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName)) {
            const name = node.tagName.text
            if (symbols.has(name) && path !== join(desktop, 'src/renderer/src', symbols.get(name)))
              found[name].push({ file: relative(repo, path), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
  }
  await scan(join(desktop, 'src/renderer/src'))
  for (const [name, hits] of Object.entries(found)) assert.ok(hits.length > 0, `${name} must have a non-definition, non-import production JSX caller`)
  assert.ok(found.TerminalServiceNotices.some(hit => hit.file.endsWith('/TerminalView.tsx')))
  assert.ok(found.ContinuousProgressControl.some(hit => hit.file.endsWith('/AgentSessionComposer.tsx')))
  return found
}
let privateRoot
try {
  result.callers = await callers()
  if (mode === 'source') {
    privateRoot = await mkdtemp('/tmp/amx-product-quality-source-')
    const copy = join(privateRoot, 'source')
    await mkdir(join(copy, 'apps'), { recursive: true })
    for (const directory of ['apps/desktop', 'packages']) {
      const copied = spawnSync('rsync', ['-a', '--exclude=node_modules', '--exclude=.tmp', '--exclude=out', '--exclude=release', '--exclude=build', join(repo, directory), join(copy, directory === 'packages' ? '' : 'apps') + '/'], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(copied.status, 0, copied.stderr)
    }
    for (const entry of await readdir(repo, { withFileTypes: true })) if (entry.isFile() && /^(package\.json|pnpm-|vitest\.|tsconfig|\.npmrc)/.test(entry.name)) await writeFile(join(copy, entry.name), await readFile(join(repo, entry.name)))
    // Each external dependency is shared read-only; local workspace package links point into the private exact source copy.
    for (const modulePath of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/layout/node_modules']) {
      const source = join(repo, modulePath), target = join(copy, modulePath)
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source)) {
        if (entry === '@agentmux') {
          await mkdir(join(target, entry), { recursive: true })
          for (const name of await readdir(join(source, entry))) await symlink(join(copy, 'packages', name), join(target, entry, name), 'dir')
        } else await symlink(join(source, entry), join(target, entry), 'dir')
      }
    }
    result.privateCopy = { exactInputs: Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(join(copy, file)))]))), externalAssets: 'Read-only dependency links; workspace package links point at the private source copy' }
    assert.deepEqual(result.privateCopy.exactInputs, result.inputs)
    const green = runTests(focused, copy)
    result.green = { ...green, log: await artifact('current-focused-green.log', green.log) }
    positive(green.log); assert.equal(green.exit, 0, green.error ?? green.log)
    const mutations = [
      { name: 'persistent-owned-summary', file: own[0], before: 'const visible = summary ?? notice.notice', after: 'const visible = notice.notice' },
      { name: 'complete-original-last-line', file: own[0], before: '<span>{notice.notice.restore}</span>', after: '<span>{null}</span>' },
      { name: 'closed-error-unknown-status', file: own[3], before: "error || displayed?.lastOutcome === 'unknown'", after: 'false' },
      { name: 'narrow-summary-full-composer-row', file: own[4], before: '.continuous-progress-control { grid-column: 1 / -1;', after: '.continuous-progress-control { grid-column: auto;' }
    ]
    result.cases = []
    async function narrowGeometry(label, flag = '--narrow-only') {
      const directory = join(evidence, label)
      const args = [join(copy, relative(repo, import.meta.filename)), '--native', flag, '--evidence=' + directory]
      const run = spawnSync(process.execPath, args, { cwd: copy, env: process.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
      const native = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
      const files = (await readdir(directory)).filter(name => name === 'render.json' || name === 'receipt.json' || name.endsWith('.png'))
      assert.ok(files.length >= 2, 'Narrow actual Native artifacts must be nonempty')
      for (const name of files) result.artifacts[relative(repo, join(directory, name))] = sha(await readFile(join(directory, name)))
      return { exit: run.status, command: [process.execPath, ...args].join(' '), log: await artifact(label + '.log', run.stdout + run.stderr), native }
    }
    for (const mutation of mutations) {
      const file = join(copy, mutation.file), original = await readFile(file, 'utf8')
      assert.equal(original.split(mutation.before).length, 2, `Mutation anchor must exist exactly once: ${mutation.name}`)
      const modified = original.replace(mutation.before, mutation.after)
      const record = { name: mutation.name, file: mutation.file, mutation: { before: mutation.before, after: mutation.after, mutatedSha256: sha(modified) } }
      try {
        await writeFile(file, modified)
        const red = runTests([focused[0]], copy)
        record.command = red.command; record.redExit = red.exit; record.log = await artifact(`${mutation.name}-red.log`, red.log)
        positive(red.log); assert.notEqual(red.exit, 0, 'The owning behavior must fail when the production bearing point is broken')
        assert.match(red.log, /AssertionError:/, 'Environment or compilation failures do not prove the behavior')
        if (mutation.name === 'narrow-summary-full-composer-row') {
          record.geometryRed = await narrowGeometry('narrow-geometry-red')
          assert.equal(record.geometryRed.exit, 1)
          assert.equal(record.geometryRed.native.failure?.name, 'AssertionError')
          assert.match(record.geometryRed.native.failure.message, /No-loop actual progress caption must fit one line|Actual narrow progress summary must contain/)
        }
      } finally { await writeFile(file, original) }
      assert.equal(sha(await readFile(file)), result.inputs[mutation.file], 'Exact production source must be restored before GREEN')
      const green = runTests([focused[0]], copy); positive(green.log); assert.equal(green.exit, 0, green.log)
      record.green = { exit: green.exit, command: green.command, log: await artifact(`${mutation.name}-restore-green.log`, green.log) }
      if (mutation.name === 'narrow-summary-full-composer-row') {
        record.geometryGreen = await narrowGeometry('narrow-geometry-restored-green')
        assert.equal(record.geometryGreen.exit, 0); assert.equal(record.geometryGreen.native.passed, true)
      }
      result.cases.push(record)
    }
    const auxiliaryMutations = [
      { file: own[7], before: "summary={{ step: notice.notice.step,\n      mode: current.failure.step === 'launch' ? 'Agent availability unconfirmed; draft and workbench kept.'\n        : `Run last observed ${current.failure.lastProcessState}; availability unconfirmed. Session, workbench and draft kept.`,\n      restore: current.failure.step === 'launch' ? 'Review details; retry Start agent with the preserved draft.'\n        : 'Review details; retry Resume for this same Session.' }}", after: 'summary={undefined}' },
      { file: own[8], before: "summary={{\n        step: 'Agent created; projection unconfirmed',\n        mode: session?.processState === 'running' ? 'Confirmed Session running; input remains available.'\n          : 'Creation confirmed; process and input unconfirmed.',\n        restore: 'Check again for this same Session and Timeline.'\n      }}", after: 'summary={undefined}' }
    ]
    const originals = new Map(), record = { name: 'concurrent-launch-lifecycle-summary-block', mutations: [] }
    try {
      for (const mutation of auxiliaryMutations) {
        const file = join(copy, mutation.file), original = await readFile(file, 'utf8')
        assert.equal(original.split(mutation.before).length, 2, 'Exact current auxiliary summary anchor')
        originals.set(file, original)
        const modified = original.replace(mutation.before, mutation.after); await writeFile(file, modified)
        record.mutations.push({ ...mutation, mutatedSha256: sha(modified) })
      }
      record.geometryRed = await narrowGeometry('concurrent-aux-summary-red', '--aux-only')
      assert.equal(record.geometryRed.exit, 1); assert.equal(record.geometryRed.native.failure?.name, 'AssertionError')
      assert.match(record.geometryRed.native.failure.message, /Concurrent lifecycle notices must retain at least three/)
    } finally { for (const [file, original] of originals) { await writeFile(file, original); assert.equal(sha(await readFile(file)), sha(original)) } }
    record.geometryGreen = await narrowGeometry('concurrent-aux-summary-restored-green', '--aux-only')
    assert.equal(record.geometryGreen.exit, 0); assert.equal(record.geometryGreen.native.passed, true)
    result.cases.push(record)
  } else {
    privateRoot = await mkdtemp('/tmp/amx-product-quality-ui-')
    const fixture = join(desktop, 'scripts/fixtures/product-quality-foundation'), loaded = new Map()
    const { build } = await import('vite')
    const xtermPath = require.resolve('@xterm/xterm'), probeFile = join(privateRoot, 'xterm-probe.mjs')
    await writeFile(probeFile, `import xterm from ${JSON.stringify(xtermPath)};\nexport class Terminal extends xterm.Terminal { constructor(...args){super(...args); const list=window.qualityTerminals ??= []; const record={id:list.length+1,terminal:this,disposed:false};list.push(record); const dispose=this.dispose.bind(this);this.dispose=()=>{record.disposed=true;dispose()};} }\n`)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: probeFile }] }, esbuild: { jsx: 'automatic' },
      plugins: [{ name: 'bind-exact-production-inputs', async transform(source, id) {
        const file = id.split('?')[0]
        if (file.startsWith(repo + '/') && !file.includes('/node_modules/') && !file.includes('/.tmp/')) loaded.set(relative(repo, file), sha(await readFile(file)))
        return null
      } }], build: { outDir: join(privateRoot, 'renderer'), emptyOutDir: true } })
    assert.ok(loaded.size > 30, 'The actual nonempty production component dependency graph must be bound')
    result.buildInputs = Object.fromEntries(loaded)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    let diagnostics = ''
    async function compiled(directory) {
      const files = []
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) files.push(...await compiled(path)); else files.push(path)
      }
      return files
    }
    const compiledFiles = await compiled(join(privateRoot, 'renderer'))
    assert.ok(compiledFiles.length >= 3)
    result.compiled = Object.fromEntries(await Promise.all(compiledFiles.map(async file => [relative(join(privateRoot, 'renderer'), file), sha(await readFile(file))])))
    result.electron = { version: require('electron/package.json').version, executableSha256: sha(await readFile(require('electron'))) }
    const execution = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(privateRoot, 'renderer/index.html'), privateRoot, evidence,
      ...(process.argv.includes('--narrow-only') ? ['--narrow-only'] : process.argv.includes('--aux-only') ? ['--aux-only'] : [])],
      { temporaryRoot: privateRoot, cwd: repo, env, timeoutMs: 120_000, onLine: line => { diagnostics += line + '\n' } })
    result.execution = execution; await artifact('electron.log', diagnostics)
    result.render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
    assert.equal(execution.exitCode, 0, JSON.stringify(result.render.failure)); assert.equal(execution.timedOut, false)
    assert.equal(result.render.passed, true)
    assert.deepEqual(await hashes([...loaded.keys()]), result.buildInputs, 'The renderer must have been built from the exact current source')
    for (const name of await readdir(evidence)) if (name.endsWith('.png') || name === 'render.json') result.artifacts[relative(repo, join(evidence, name))] = sha(await readFile(join(evidence, name)))
  }
  result.restored = await hashes(inputs); assert.deepEqual(result.restored, result.inputs)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message } }
finally {
  if (privateRoot) {
    await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot)
    result.cleanup = { remaining: await listProbeProcesses(process.pid + 1_000_000_000, privateRoot) }
    assert.deepEqual(result.cleanup.remaining, [])
    await rm(privateRoot, { recursive: true }); result.cleanup.rootRemoved = true
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, mode, cases: result.cases?.length, frames: result.render?.frames.length, receipt: relative(repo, join(evidence, 'receipt.json')), failure: result.failure }))
if (!result.passed) process.exitCode = 1
