import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assertCoreDistBuiltFromCurrentSource from '../vitest.dist-freshness.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mutations = process.argv.includes('--mutations')
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })
await assertCoreDistBuiltFromCurrentSource()
run(process.execPath, ['packages/core/scripts/verify-capsule-runtime-unit.mjs', ...(mutations ? ['--mutations'] : [])])

const fixture = await mkdtemp(join(tmpdir(), 'amxc-'))
const runtime = join(fixture, 'r'), state = join(fixture, 's')
await mkdir(runtime, { mode: 0o700 }); await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
  AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
  AGENTMUX_MOBILE_BUILD_DIRECTORY: join(fixture, 'no-mobile-assets'),
}
const daemon = spawn(join(root, 'packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
  ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
  { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
let host, daemonErrors = ''
daemon.stderr.on('data', data => { daemonErrors += data })

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  child.kill('SIGTERM')
  try { await closed } finally { clearTimeout(deadline) }
}
async function ready(child, stream, label) {
  return await new Promise((yes, no) => {
    let text = '', errors = ''
    const timer = setTimeout(() => no(new Error(`${label} readiness timed out: ${errors}`)), 15000)
    child.stderr.on('data', data => { errors += data })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('exit', code => { clearTimeout(timer); no(new Error(`${label} exited ${code}: ${errors}`)) })
    stream.on('data', data => {
      text += data
      if (label === 'Native' || text.includes('\n')) { clearTimeout(timer); yes(text) }
    })
  })
}
async function start(entry = join(root, 'packages/core/bin/agentmux-runtime')) {
  host = spawn(process.execPath, [entry, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const publication = JSON.parse((await ready(host, host.stdout, 'Host')).split('\n')[0])
  assert.equal(publication.owner.processId, host.pid, 'Readiness must identify the actual original Core process')
  return publication
}
async function cli(action, input) {
  const args = [join(root, 'packages/core/bin/amux'), 'capsule', ...action.split('.')]
  if (input !== undefined) args.push('--input', '-')
  return await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('The private CLI exceeded its deadline')) }, 15000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('close', code => {
      clearTimeout(timer)
      let body
      try { body = JSON.parse(stdout || stderr) } catch { no(new Error(`CLI returned no protocol result: ${stderr}`)); return }
      yes({ code, ...body })
    })
    child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
}
async function call(action, input) {
  const response = await cli(action, input)
  assert.equal(response.code, 0, `Original public CLI must complete ${action}: ${JSON.stringify(response)}`)
  assert.equal(response.ok, true)
  return response.result
}
async function source(name, marker) {
  const path = join(fixture, name)
  await mkdir(path)
  await writeFile(join(path, 'index.html'), `<html><head><link rel="stylesheet" href="style.css"></head><body>${marker}</body></html>`)
  await writeFile(join(path, 'style.css'), 'body { color: teal; }')
  return path
}
async function page(url, marker) {
  const response = await fetch(url, { headers: { Accept: 'text/html' } })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes(marker), 'HTTP must serve the actual published bytes')
}

async function waitRuntime(predicate, label) {
  let value
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await call('runtime.inspect')
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}
let servicePid
try {
  await ready(daemon, daemon.stdio[3], 'Native')
  const firstCore = await start()
  assert.equal((await call('runtime.inspect')).phase, 'unconfigured', 'Empty inspection must not create a service')
  const sourcePath = await source('content', 'original-page')
  const created = await call('create', { operationId: 'create-page', sourcePath, mode: 'injected' })
  assert.equal(created.status, 'committed'); assert.equal(created.endpoint.status, 'available')
  const first = await waitRuntime(v => v.phase === 'running', 'Initial independent service handshake')
  servicePid = first.runtime.pid
  assert.notEqual(servicePid, host.pid); assert.notEqual(servicePid, daemon.pid)
  const instance = (await fetch(created.endpoint.url)).headers.get('x-agentmux-capsule-instance')
  await page(created.endpoint.url, 'original-page')
  await stop(host)
  assert.equal((await fetch(created.endpoint.url)).headers.get('x-agentmux-capsule-instance'), instance, 'Core exit must preserve the same HTTP process')
  const nextCore = await start()
  assert.equal(nextCore.owner.runtimeId, firstCore.owner.runtimeId)
  const reconnected = await call('runtime.inspect')
  assert.deepEqual(reconnected.run, first.run); assert.deepEqual(reconnected.runtime, first.runtime)
  const killed = once(host, 'close'); host.kill('SIGKILL'); await killed
  await page(created.endpoint.url, 'original-page')
  await start()
  assert.deepEqual((await call('runtime.inspect')).run, first.run)
  process.kill(servicePid, 'SIGKILL')
  const recovered = await waitRuntime(v => v.phase === 'running' && v.runtime.ownerInstanceId !== first.runtime.ownerInstanceId, 'Terminal service generation recovery')
  servicePid = recovered.runtime.pid
  assert.notEqual(recovered.run.runId, first.run.runId); assert.equal(recovered.runtime.runtimeId, first.runtime.runtimeId)
  assert.notEqual((await fetch(created.endpoint.url)).headers.get('x-agentmux-capsule-instance'), instance)
  assert.equal((await call('inspect', { capsuleId: created.record.capsuleId })).record.port, created.record.port)
  await call('runtime.stop', { operationId: 'stop-service', expectedRevision: recovered.revision, expectedRun: { runId: recovered.run.runId } })
  const stopped = await waitRuntime(v => v.phase === 'stopped', 'Original Stop completion')
  servicePid = undefined
  await stop(host); await start()
  assert.equal((await call('runtime.inspect')).phase, 'stopped', 'Stop intent must survive Core restart')
  const refused = await cli('ls')
  assert.notEqual(refused.code, 0); assert.equal(refused.error.code, 'CAPSULE_RUNTIME_STOPPED')
  await call('runtime.start', { operationId: 'resume-service', expectedRevision: stopped.revision })
  const resumed = await waitRuntime(v => v.phase === 'running', 'Explicit resume')
  servicePid = resumed.runtime.pid
  assert.notEqual(resumed.run.runId, recovered.run.runId); assert.equal(resumed.runtime.runtimeId, first.runtime.runtimeId)
  await page(created.endpoint.url, 'original-page')
  process.stdout.write('Capsule runtime: actual bare Core, compiled CLI, private ctxmux and independent service passed; Core exit/SIGKILL preserves original HTTP/Run, terminal generation recovers original page/port, explicit Stop survives restart, explicit Start resumes. Cross-machine route is not claimed by this local fixture.\n')
} finally {
  if (host?.exitCode === null && host?.signalCode === null) try {
    const current = await call('runtime.inspect')
    if (current.desired === 'running') await call('runtime.stop', { operationId: 'cleanup-service', expectedRevision: current.revision, expectedRun: current.run ? { runId: current.run.runId } : null })
  } catch {}
  await stop(host)
  if (servicePid) try { process.kill(servicePid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await stop(daemon)
  await rm(fixture, { recursive: true, force: true })
}
