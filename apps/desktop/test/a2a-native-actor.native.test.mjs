import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile), sleep = ms => new Promise(done => setTimeout(done, ms))
test('the authenticated synthetic native owner reports its actual loaded idle thread and exact queued input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-actor-test-')), token = randomUUID(), session = 'private-fixture-session'
  const controls = join(root, 'control'), nativeHome = join(root, 'native')
  await mkdir(controls); await mkdir(nativeHome)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/fixtures/a2a-inbox-product/native-agent.mjs', import.meta.url)),
    'app-server', '--ws-token-sha256', createHash('sha256').update(token).digest('hex')], { cwd: root, stdio: 'ignore',
    env: { ...process.env, HOME: root, CODEX_HOME: nativeHome, AGENTMUX_AGENT_SESSION_ID: session,
      AGENTMUX_A2A_PROOF_DIRECTORY: controls, AGENTMUX_CODEX_ACTOR_TOKEN: token } })
  const exited = once(child, 'exit'); let ws
  try {
    let endpoint
    const deadline = Date.now() + 5000
    while (!endpoint && Date.now() < deadline) {
      const output = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn']).then(value => value.stdout,
        error => { if (error.code === 1 && !error.stderr) return ''; throw error })
      endpoint = /^n127\.0\.0\.1:(\d+)$/mu.exec(output)?.[1]
      if (!endpoint) await sleep(20)
    }
    assert.ok(endpoint, 'The exact private actor owns a listening endpoint')
    // The current Node WebSocket port has no custom request headers; ws is the existing actor dependency.
    const { createRequire } = await import('node:module'), require = createRequire(import.meta.url), { WebSocket } = require('ws')
    ws = new WebSocket('ws://127.0.0.1:' + endpoint, { headers: { authorization: 'Bearer ' + token } })
    await once(ws, 'open')
    const call = async (method, params) => {
      const id = randomUUID(), result = once(ws, 'message')
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const reply = JSON.parse(String((await result)[0])); assert.equal(reply.id, id); assert.equal(reply.error, undefined); return reply.result
    }
    await call('initialize', { capabilities: { experimentalApi: true } })
    const original = (await call('thread/start', { cwd: root })).thread
    assert.equal(original.canAcceptDirectInput, true); assert.deepEqual(original.status, { type: 'idle' })
    assert.equal((await call('thread/read', { threadId: original.id, includeTurns: false })).thread.id, original.id)
    await writeFile(join(controls, session + '.control.json'), JSON.stringify({ effect: 'unavailable' }))
    assert.equal((await call('thread/read', { threadId: original.id, includeTurns: false })).thread.canAcceptDirectInput, false)
    await rm(join(controls, session + '.control.json'))
    const input = [{ type: 'text', text: 'original bounded notification', text_elements: [] }], clientUserMessageId = randomUUID()
    const accepted = await call('thread/queue/add', { threadId: original.id, input, clientUserMessageId })
    assert.deepEqual(accepted.queuedSubmission.input, input); assert.equal(accepted.queuedSubmission.clientUserMessageId, clientUserMessageId)
    assert.deepEqual((await call('thread/read', { threadId: original.id, includeTurns: false })).thread.status, { type: 'idle' })
    const native = (await readFile(join(nativeHome, 'sessions', 'rollout-' + original.id + '.jsonl'), 'utf8')).split('\n').filter(Boolean).map(row => JSON.parse(row))
    assert.equal(native.filter(row => row.payload?.item?.client_id === clientUserMessageId).length, 1)
  } finally { ws?.terminate(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }) }
})
