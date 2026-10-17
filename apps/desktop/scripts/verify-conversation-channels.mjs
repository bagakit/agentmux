import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, browserInstalledDependency, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/conversation-channels')
const evidence = resolve(root, '.local/conversation-channels/runs', randomUUID())
const temporary = await mkdtemp(resolve(tmpdir(), 'amux-conversation-channels-'))
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, captureOnly: process.argv.includes('--capture-only'), aestheticReview: 'not-performed',
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mutations: [], inputs: {} }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const file of ['verify-conversation-channels.mjs', ...['entry.tsx', 'main.cjs', 'vitest.config.mts', 'index.html'].map(name => 'fixtures/conversation-channels/' + name)]) {
    const path = 'apps/desktop/scripts/' + file
    receipt.inputs[path] = sha(await readFile(resolve(root, path)))
  }
  for (const mode of process.argv.includes('--capture-only') ? [] : [
    { name: 'normal' },
    { name: 'catalog', pattern: 'catalog:' },
    { name: 'native', pattern: 'visited Host instance and draft' },
    { name: 'lark', pattern: 'discovers Lark from Conversation Channels' },
    { name: 'restored' }
  ]) {
    const directory = resolve(evidence, mode.name); await mkdir(directory)
    const output = resolve(directory, 'results.json'), lines = []
    const args = [desktopRequire.resolve('vitest/vitest.mjs'), 'run', '--config', resolve(fixture, 'vitest.config.mts'), '--reporter=json', '--outputFile', output]
    if (mode.pattern) args.push('--testNamePattern', mode.pattern)
    const execution = await runProbeProcess(process.execPath, args, { cwd: root, temporaryRoot: temporary, env: { ...env,
      AGENTMUX_CHANNELS_EVIDENCE: directory, AGENTMUX_CHANNELS_MUTANT: mode.pattern ? mode.name : 'baseline' },
      timeoutMs: 60000, onLine: line => lines.push(line) })
    await writeFile(resolve(directory, 'test.log'), lines.join('\n'))
    const result = JSON.parse(await readFile(output, 'utf8'))
    if (!mode.pattern) assert.equal(execution.exitCode, 0, lines.join('\n'))
    const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    const applied = loaded.filter(item => item.applied)
    assert.ok(loaded.length > 0, 'Actual nonempty production source load')
    assert.equal(execution.timedOut, false, 'Timeout is not business assertion RED')
    if (mode.pattern) {
      assert.equal(execution.exitCode, 1); assert.equal(result.numFailedTests, 1)
      assert.equal(applied.length, 1)
      assert.notEqual(applied[0].original, applied[0].consumed)
      const failures = result.testResults.flatMap(test => test.assertionResults ?? []).filter(test => test.status === 'failed')
      assert.equal(failures.length, 1)
      assert.match(failures[0].failureMessages.join('\n'), /AssertionError|expected .*to /u)
      receipt.mutations.push({ mode: mode.name, passed: false, assertionRED: true, applied, failures })
    } else {
      assert.ok(result.numPassedTests > 0); assert.equal(applied.length, 0)
      receipt.mutations.push({ mode: mode.name, passed: true, tests: result.numPassedTests })
    }
  }
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
  const compiled = resolve(temporary, 'compiled')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { alias: aliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-conversation-channel-renderer', enforce: 'pre', resolveId: browserInstalledDependency,
      transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) receipt.inputs[relative(root, file)] = sha(code)
      } }], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  await cp(compiled, resolve(evidence, 'compiled'), { recursive: true })
  receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled, { recursive: true })).filter(name => /\.(?:html|js|css)$/u.test(name))
    .map(async name => [name, sha(await readFile(resolve(compiled, name)))])))
  const visual = resolve(evidence, 'visual'); await mkdir(visual)
  const lines = []
  const execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'index.html'), temporary, visual],
    { cwd: root, temporaryRoot: temporary, env, timeoutMs: 60000, onLine: line => lines.push(line) })
  await writeFile(resolve(visual, 'capture.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(resolve(visual, 'render.json'), 'utf8'))
  assert.equal(execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  assert.deepEqual([...render.frames].sort(), ['overview-wide.png', 'amux-wide.png', 'lark-wide.png', 'lark-original-unknown.png', 'amux-narrow.png', 'lark-narrow.png'].sort())
  receipt.render = render
  receipt.images = Object.fromEntries(await Promise.all(render.frames.map(async image => [image, sha(await readFile(resolve(visual, image)))])))
  assert.ok(Object.keys(receipt.inputs).length > 0)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  throw error
} finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  assert.deepEqual(receipt.cleanup.remaining, [])
  await rm(temporary, { recursive: true, force: true })
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await writeFile(resolve(root, '.local/conversation-channels/latest.json'), JSON.stringify({ evidence, receipt: resolve(evidence, 'receipt.json') }, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, evidence }))
}
