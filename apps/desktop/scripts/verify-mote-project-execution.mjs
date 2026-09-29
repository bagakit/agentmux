import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const output = join(base, '.tmp/mote-project-execution')
const last = join(output, 'capture-last.json')
const owning = ['apps/desktop/src/shared/scratch-topics.ts', 'apps/desktop/src/main/scratch-topics.ts', 'packages/core/src/agentmux-cli-help.ts']
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const current = async () => Object.fromEntries(await Promise.all(owning.map(async path => [path, await hash(join(base, path))])))
const run = async (command, args, env, timeout = 10000) => {
  const child = spawn(command, args, { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
  try { const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) }); return { ...exit, stdout, stderr } }
  finally { clearTimeout(timer) }
}

if (process.argv[2] === '--capture') {
  await mkdir(output, { recursive: true })
  const attempt = await mkdtemp(join(output, 'attempt-'))
  const root = await mkdtemp('/tmp/amx-mote-project-')
  await chmod(root, 0o700)
  const receipt = { schema: 'agentmux.mote-project-capture.v1', passed: false, attempt, root, source: await current(), preflight: {}, compiled: null, failure: null }
  try {
    const seed = process.env.CODEX_HOME?.trim()
    assert.ok(seed, 'Explicit CODEX_HOME seed is required')
    const selectors = await readFile(join(seed, 'config.toml'), 'utf8')
    const model = selectors.match(/^model\s*=\s*"([^"]+)"/m)?.[1]
    assert.ok(model, 'Seed declares no exact model')
    for (const name of ['codex-home', 'runtime', 'state', 'home']) await mkdir(join(root, name), { mode: 0o700 })
    for (const name of ['auth.json', 'config.toml']) { await copyFile(join(seed, name), join(root, 'codex-home', name)); await chmod(join(root, 'codex-home', name), 0o600) }
    const env = { ...process.env, CODEX_HOME: join(root, 'codex-home'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
    for (const name of ['AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_HOOK_TOKEN', 'AGENTMUX_HOOK_URL']) delete env[name]
    const located = await run('/usr/bin/which', ['codex'], env)
    assert.equal(located.code, 0, 'Codex executable unavailable')
    const executable = located.stdout.trim()
    const version = await run(executable, ['--version'], env)
    const auth = await run(executable, ['--config', 'cli_auth_credentials_store="file"', 'login', 'status'], env)
    receipt.preflight = { version: version.stdout.trim(), versionOk: version.code === 0, authOk: auth.code === 0, model, executable }
    assert.ok(receipt.preflight.versionOk && receipt.preflight.authOk, 'Private version/auth preflight failed')
    const require = createRequire(join(base, 'packages/core/package.json')), { build } = await import(require.resolve('esbuild'))
    const bundle = join(attempt, 'worker.mjs')
    const result = await build({ absWorkingDir: base, entryPoints: [join(base, 'apps/desktop/scripts/fixtures/mote-project-execution/entry.mjs')], outfile: bundle,
      bundle: true, packages: 'external', platform: 'node', format: 'esm', metafile: true, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, logLevel: 'silent',
      plugins: [{ name: 'original-layout-and-private-host', setup(build) {
        build.onResolve({ filter: /^@agentmux\/layout$/ }, () => ({ path: join(base, 'packages/layout/src/index.ts') }))
        build.onResolve({ filter: /^@agentmux\/demand$/ }, () => ({ path: join(base, 'packages/demand/src/index.ts') }))
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'private-node-host', namespace: 'private-node-host' }))
        build.onLoad({ filter: /.*/, namespace: 'private-node-host' }, () => ({ contents: 'export const app = { getAppMetrics: () => [], getPath: () => process.argv[2] }', loader: 'js' }))
      } }] })
    await symlink(join(base, 'apps/desktop/node_modules'), join(attempt, 'node_modules'))
    const inputs = {}
    for (const path of Object.keys(result.metafile.inputs)) if (!path.includes(':')) inputs[path] = await hash(resolve(base, path))
    assert.ok(Object.keys(inputs).length > 0, 'Compiled input inventory is empty')
    receipt.compiled = { path: bundle, sha256: await hash(bundle), inputs,
      external: Object.fromEntries(await Promise.all(['packages/core/dist/index.js', 'packages/core/dist/client.js', 'packages/core/dist/agentmux.js', 'packages/core/dist/agentmux-cli-help.js', 'packages/core/dist/control-host.js'].map(async path => [path, await hash(join(base, path))]))) }
    await writeFile(join(attempt, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
    const worker = await run(process.execPath, [bundle, root, attempt, executable, model], env, 360000)
    await writeFile(join(attempt, 'worker.stdout'), worker.stdout); await writeFile(join(attempt, 'worker.stderr'), worker.stderr)
    receipt.exit = { code: worker.code, signal: worker.signal }
    const behavior = JSON.parse(await readFile(join(attempt, 'behavior.json'), 'utf8'))
    receipt.evidence = Object.fromEntries(await Promise.all(['behavior.json', 'worker.stdout', 'worker.stderr', ...(behavior.passed ? ['A.json', 'B.json', 'execution.json'] : [])].map(async name => [name, await hash(join(attempt, name))])))
    receipt.passed = worker.code === 0 && behavior.passed && behavior.cleanup.errors.length === 0
    assert.ok(receipt.passed, behavior.failure?.message ?? 'Behavior or cleanup failed')
  } catch (error) { receipt.failure = error.message; process.exitCode = 1 }
  finally {
    await rm(join(root, 'codex-home'), { recursive: true, force: true })
    await writeFile(join(attempt, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
    await writeFile(last, JSON.stringify({ attempt, captureSha256: await hash(join(attempt, 'capture.json')) }, null, 2) + '\n')
    console.log(JSON.stringify({ passed: receipt.passed, attempt, stage: receipt.failure ?? 'complete' }))
  }
} else if (process.argv[2] === '--verify-evidence') {
  const pointer = JSON.parse(await readFile(last, 'utf8')), capturePath = join(pointer.attempt, 'capture.json')
  assert.equal(await hash(capturePath), pointer.captureSha256, 'Capture receipt changed')
  const capture = JSON.parse(await readFile(capturePath, 'utf8'))
  assert.equal(capture.passed, true, 'No passing real behavior capture')
  assert.deepEqual(await current(), capture.source, 'Mote Notes Source differs from captured candidate')
  assert.equal(await hash(capture.compiled.path), capture.compiled.sha256, 'Compiled identity changed')
  assert.ok(Object.keys(capture.evidence).length >= 6, 'Evidence inventory is incomplete')
  for (const [name, sha256] of Object.entries(capture.evidence)) assert.equal(await hash(join(pointer.attempt, name)), sha256, 'Evidence bytes changed: ' + name)
  assert.ok(Object.keys(capture.compiled.inputs).length > 0, 'No compiled inputs')
  const behavior = JSON.parse(await readFile(join(pointer.attempt, 'behavior.json'), 'utf8'))
  assert.equal(behavior.passed, true)
  assert.equal(behavior.A.projectCount, 0); assert.equal(behavior.A.demandCount, 0)
  assert.equal(behavior.inputs.length, 2)
  assert.equal(behavior.creations[0].input.prompt, behavior.inputs[0].text)
  assert.ok(behavior.runs.length >= 2 && behavior.result.demand.sessionIds.includes(behavior.result.execution.agentSessionId), 'No real execution binding')
  assert.equal(behavior.result.creation.receipt.creation.initialPrompt, 'confirmed')
  assert.equal(behavior.result.artifact.trim(), 'HELLO')
  assert.ok(behavior.calls.some(call => call.request.operation === 'settings.workspaces.add' && call.result?.item.id === behavior.result.project.id), 'No original Project owner receipt')
  assert.ok(behavior.calls.some(call => call.request.operation === 'demand.link-session' && call.result?.receipt.sessionId === behavior.result.execution.agentSessionId), 'No actual public link receipt')
  for (const name of ['A', 'B', 'execution']) {
    const value = JSON.parse(await readFile(join(pointer.attempt, name + '.json'), 'utf8'))
    assert.ok(value.replay.replay.length > 0 && value.status.run.latestOutputBytes > 0, 'Empty ordered output')
  }
  const execution = JSON.parse(await readFile(join(pointer.attempt, 'execution.json'), 'utf8'))
  const tools = execution.timeline.items.filter(item => item.kind === 'tool_call' && item.status === 'complete')
  assert.ok(tools.length > 0, 'Execution tool evidence is empty')
  assert.ok(tools.some(item => item.agentSessionId === behavior.result.execution.agentSessionId &&
    item.toolInput?.includes('/result.txt') && item.toolOutput?.includes('48454c4c4f')), 'No actual execution Agent file/readback evidence')
  assert.equal(behavior.cleanup.errors.length, 0)
  console.log(JSON.stringify({ passed: true, attempt: pointer.attempt, model: behavior.model, runs: behavior.runs.length, scope: behavior.scope }))
} else throw new Error('Use explicit --capture or --verify-evidence; verification never starts a model')
