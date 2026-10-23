import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assertCoreDistBuiltFromCurrentSource, { staleDistComplaint } from '../vitest.dist-freshness.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mutations = process.argv.includes('--mutations')
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })
await assertCoreDistBuiltFromCurrentSource()
assert.equal(await staleDistComplaint(join(root, 'packages/capsule')), null, 'Build the current standalone Capsule package before this product proof')
run(process.execPath, ['apps/host/scripts/build.mjs'])
run('pnpm', ['--filter', '@agentmux/host', 'typecheck'])
run(process.execPath, ['--test', ...(await readdir(join(root, 'packages/capsule/test')))
  .filter(name => name.endsWith('.test.mjs')).map(name => join('packages/capsule/test', name))])
run(process.execPath, ['packages/core/scripts/verify-capsule-core.mjs', ...(mutations ? ['--mutations'] : [])])
if (mutations) run('pnpm', ['--filter', '@agentmux/capsule', 'test:mutation'])

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
async function start(entry = join(root, 'apps/host/dist/index.js')) {
  host = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const publication = JSON.parse((await ready(host, host.stdout, 'Host')).split('\n')[0])
  assert.equal(publication.pid, host.pid, 'Readiness must identify the actual original Host process')
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
  if (response.code !== 0 && input?.operationId && response.error?.code === 'CAPSULE_OPERATION_UNKNOWN')
    process.stderr.write('Original operation observation: ' + JSON.stringify(await cli('operation.inspect', { operationId: input.operationId })) + '\n')
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

try {
  await ready(daemon, daemon.stdio[3], 'Native')
  const firstHost = await start()
  const originals = []
  for (const storageMode of ['managed', 'path']) for (const mode of ['isolated', 'injected']) {
    const marker = `${storageMode}-${mode}`
    const sourcePath = await source(marker, marker)
    const input = { operationId: `create-${marker}`, sourcePath, storageMode, mode, routing: 'spa' }
    const created = await call('create', input)
    assert.equal(created.status, 'committed')
    assert.match(created.record.capsuleId, /^[1-9A-HJ-NP-Za-km-z]{12}$/)
    assert.equal(created.record.storageMode, storageMode); assert.equal(created.record.mode, mode)
    assert.equal(created.endpoint.status, 'available')
    await page(created.endpoint.url, marker)
    assert.equal((await fetch(new URL('style.css', created.endpoint.url))).headers.get('content-type'), 'text/css; charset=utf-8')
    await page(new URL('a/deep/route', created.endpoint.url), marker)
    assert.equal((await fetch(new URL('missing.js', created.endpoint.url))).status, 404)
    assert.equal((await fetch(created.endpoint.url, { method: 'POST', body: '{}' })).status, 405)
    const replay = await call('create', input)
    assert.deepEqual(replay.record, created.record, 'Repeated original operation must retain one exact identity')
    originals.push({ ...created, input, marker })
  }
  assert.equal(new Set(originals.map(page => page.record.port)).size, 4, 'Each page has a distinct persistent origin')
  const managed = originals[0], external = originals[2]
  await rm(managed.input.sourcePath, { recursive: true })
  await page(managed.endpoint.url, managed.marker)
  await writeFile(join(external.input.sourcePath, 'index.html'), 'external-live-change')
  await page(external.endpoint.url, 'external-live-change')
  const before = (await call('config.inspect')).config
  const nextRoot = join(fixture, 'new-content')
  const saved = await call('config.update', { operationId: 'defaults-save', expectedRevision: before.revision, changes: { contentRoot: nextRoot } })
  assert.equal(saved.config.contentRoot, nextRoot)
  assert.equal((await call('inspect', { capsuleId: managed.record.capsuleId })).record.contentRoot, managed.record.contentRoot)
  const conflict = await cli('config.update', { operationId: 'defaults-conflict', expectedRevision: before.revision, changes: { defaultMode: 'injected' } })
  assert.notEqual(conflict.code, 0); assert.equal(conflict.error.code, 'CAPSULE_REVISION_CONFLICT')
  const replacement = await source('replacement', 'published-revision-two')
  const updated = await call('update', { capsuleId: managed.record.capsuleId, operationId: 'publish-update', expectedRevision: 1, changes: { sourcePath: replacement } })
  assert.equal(updated.record.revision, 2)
  await page(managed.endpoint.url, 'published-revision-two')
  const failed = await cli('update', { capsuleId: managed.record.capsuleId, operationId: 'publish-missing', expectedRevision: 2, changes: { sourcePath: join(fixture, 'missing') } })
  assert.notEqual(failed.code, 0)
  await page(managed.endpoint.url, 'published-revision-two')
  const asked = await call('interaction.request', { capsuleId: managed.record.capsuleId, operationId: 'question-save', question: 'Which layout?', draft: 'Keep this draft' })
  const opened = await call('open', { capsuleId: managed.record.capsuleId, operationId: 'headless-open' })
  assert.equal(opened.rendering.status, 'unavailable')
  assert.equal((await call('operation.inspect', { operationId: 'headless-open' })).operation.status, 'committed')
  await stop(host)
  await page(managed.endpoint.url, 'published-revision-two')
  await start()
  const service = await call('runtime.inspect')
  await call('runtime.stop', { operationId: 'stop-for-port-conflict', expectedRevision: service.revision, expectedRun: { runId: service.run.runId } })
  let stopped
  for (let attempt = 0; attempt < 100; attempt++) {
    stopped = await call('runtime.inspect')
    if (stopped.phase === 'stopped') break
    await new Promise(yes => setTimeout(yes, 100))
  }
  assert.equal(stopped.phase, 'stopped')
  await stop(host)
  const occupied = createServer((_req, res) => res.end('private-conflict'))
  await new Promise((yes, no) => { occupied.once('error', no); occupied.listen(managed.record.port, '127.0.0.1', yes) })
  try {
    const restarted = await start()
    assert.notEqual(restarted.pid, firstHost.pid, 'A real new Host process must read the original durable data')
    assert.equal(restarted.owner.runtimeId, firstHost.owner.runtimeId)
    assert.equal((await call('runtime.inspect')).phase, 'stopped')
    await call('runtime.start', { operationId: 'start-with-port-conflict', expectedRevision: stopped.revision })
    const retained = await call('inspect', { capsuleId: managed.record.capsuleId })
    assert.equal(retained.record.port, managed.record.port); assert.equal(retained.record.revision, 2)
    assert.equal(retained.endpoint.status, 'unavailable', 'A conflict must retain the original endpoint, never silently choose another port')
    await page(external.endpoint.url, 'external-live-change')
    assert.equal((await call('interaction.inspect', { capsuleId: managed.record.capsuleId, interactionId: asked.interaction.interactionId })).interaction.draft, 'Keep this draft')
    assert.equal((await call('config.inspect')).config.contentRoot, nextRoot)
  } finally { await new Promise((yes, no) => occupied.close(error => error ? no(error) : yes())) }
  const resolved = await call('resolve', { capsuleId: managed.record.capsuleId })
  assert.equal(resolved.endpoint.status, 'available'); assert.equal(resolved.endpoint.port, managed.record.port)
  await page(resolved.endpoint.url, 'published-revision-two')
  assert.equal((await call('ls')).capsules.length, 4)
  const removed = await call('remove', { capsuleId: external.record.capsuleId, operationId: 'remove-path', expectedRevision: 1, deleteContent: true })
  assert.equal(removed.deletedContent, false)
  assert.equal(await readFile(join(external.input.sourcePath, 'index.html'), 'utf8'), 'external-live-change')
  await writeFile(join(state, 'capsules/records', `${originals[3].record.capsuleId}.json`), '{unreadable')
  const observed = await call('ls')
  assert.equal(observed.capsules.length, 2); assert.ok(observed.issues.length > 0)
  await stop(host)

  if (mutations) {
    const require = createRequire(join(root, 'apps/host/package.json'))
    const { transform } = require('esbuild')
    const entry = join(fixture, 'host-without-capsule.mjs')
    const modules = join(fixture, 'node_modules/@agentmux'), isolatedCore = join(modules, 'core')
    await mkdir(isolatedCore, { recursive: true })
    await cp(join(root, 'packages/core/dist'), join(isolatedCore, 'dist'), { recursive: true })
    await cp(join(root, 'packages/core/package.json'), join(isolatedCore, 'package.json'))
    await symlink(join(root, 'packages/core/node_modules'), join(isolatedCore, 'node_modules'), 'dir')
    await symlink(join(root, 'packages/core/vendor'), join(isolatedCore, 'vendor'), 'dir')
    for (const name of ['capsule', 'relay']) await symlink(join(root, 'packages', name), join(modules, name), 'dir')
    await cp(join(root, 'apps/host/dist/index.js'), entry)
    const original = await readFile(join(root, 'packages/core/src/headless-runtime.ts'), 'utf8')
    const anchor = 'capsules: options.service?.capsules ?? capsules,'
    assert.equal(original.split(anchor).length, 2, 'Mutant must consume the actual default Core owner composition')
    const changed = original.replace(anchor, 'capsules: options.service?.capsules,')
    assert.notEqual(createHash('sha256').update(original).digest('hex'), createHash('sha256').update(changed).digest('hex'))
    await writeFile(join(isolatedCore, 'dist/headless-runtime.js'), (await transform(changed, { loader: 'ts', format: 'esm', target: 'node24' })).code)
    await start(entry)
    let semanticRed = false
    try { await call('create', { operationId: 'must-use-host-owner', sourcePath: replacement }) }
    catch (error) { semanticRed = error.code === 'ERR_ASSERTION' && error.message.includes('Original public CLI must complete create') }
    assert.ok(semanticRed, 'Removing the actual default Core owner must break the real CLI outcome')
    await stop(host)
    await start()
    assert.equal((await call('resolve', { capsuleId: managed.record.capsuleId })).endpoint.status, 'available')
  }
  process.stdout.write(`Capsule public path: real CLI, Host, HTTP, persistent identities and process restart passed${mutations ? '; source mutations passed' : ''}.\n`)
} finally {
  if (host?.exitCode === null && host?.signalCode === null) try {
    const service = await call('runtime.inspect')
    if (service.desired === 'running') await call('runtime.stop', { operationId: 'public-proof-cleanup', expectedRevision: service.revision, expectedRun: service.run ? { runId: service.run.runId } : null })
  } catch {}
  await stop(host); await stop(daemon)
  await rm(fixture, { recursive: true, force: true })
}
