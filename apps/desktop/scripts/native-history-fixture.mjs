import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function withNativeHelper({ nativeCommand, home, cwd, purpose }, action) {
  const receipt = { purpose, methods: [], outputBytes: 0, stderrBytes: 0, nativeUserAgent: null }
  const child = spawn(nativeCommand, ['-s', 'read-only', '-a', 'never', 'app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: home }, cwd,
    detached: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  receipt.pid = child.pid
  let sequence = 0, carry = '', failure
  const pending = new Map()
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  const fail = error => {
    failure ??= error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  const stderrHash = createHash('sha256')
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stderr.on('data', chunk => { receipt.stderrBytes += chunk.length; stderrHash.update(chunk) })
  child.stdout.setEncoding('utf8').on('data', chunk => {
    receipt.outputBytes += Buffer.byteLength(chunk)
    if (receipt.outputBytes > 2 * 1024 * 1024) return fail(new Error('private native stdout budget exceeded'))
    carry += chunk
    const lines = carry.split('\n'); carry = lines.pop()
    for (const line of lines) {
      if (!line) continue
      try {
        const message = JSON.parse(line)
        if (!Object.hasOwn(message, 'id')) continue
        const waiter = pending.get(message.id)
        if (!waiter) return fail(new Error('unexpected native RPC id'))
        pending.delete(message.id)
        if (message.error) {
          receipt.nativeError = { method: waiter.method, code: message.error.code, message: message.error.message }
          waiter.reject(new Error(`${waiter.method} native error ${message.error.code}: ${message.error.message}`))
        } else waiter.resolve(message.result)
      } catch (error) { fail(error) }
    }
  })
  child.on('close', () => { if (pending.size) fail(new Error('native helper exited with pending RPC')) })
  const deadline = setTimeout(() => {
    fail(new Error('private native helper exceeded 20 second deadline'))
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }, 20_000)
  const request = (method, params) => {
    if (failure) return Promise.reject(failure)
    const id = ++sequence
    receipt.methods.push(method)
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  let result
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'agentmux_private_native_fixture', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    })
    receipt.nativeUserAgent = initialized.userAgent
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    result = await action(request, receipt)
  } catch (error) {
    error.nativeHelperReceipt = receipt
    throw error
  } finally {
    child.stdin.end()
    let eofTimer
    const closed = await Promise.race([exit, new Promise(resolve => { eofTimer = setTimeout(() => resolve(null), 2_000) })])
    clearTimeout(eofTimer)
    if (!closed) {
      receipt.forcedCleanup = true
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    receipt.exit = closed ?? await exit
    clearTimeout(deadline)
    receipt.stderrSha256 = stderrHash.digest('hex')
    receipt.helperReaped = true
  }
  return { result, receipt }
}

/** Owner preparation only. The caller owns root until all later readers have closed. */
export async function prepareNativeFixture({ root, nativeCommand = 'codex', count = 61 }) {
  assert.ok(Number.isInteger(count) && count >= 61 && count <= 100)
  const home = join(root, 'codex-home')
  const day = join(home, 'sessions', '2026', '10', '01')
  await mkdir(day, { recursive: true })
  // Offline fixture provider prevents a metadata preparation from reaching any model.
  await writeFile(join(home, 'config.toml'), [
    'model = "fixture-model"', 'model_provider = "fixture_provider"',
    '[model_providers.fixture_provider]', 'name = "Synthetic offline fixture"',
    'base_url = "http://127.0.0.1:1/v1"', 'wire_api = "responses"',
    '[memories]', 'disable_on_external_context = true', ''
  ].join('\n'))
  const threadId = randomUUID()
  const timestamp = '2026-10-01T00:00:00Z'
  const rollout = join(day, `rollout-2026-10-01T00-00-00-${threadId}.jsonl`)
  const records = [{ ordinal: 0, timestamp, type: 'session_meta', payload: {
    session_id: threadId, id: threadId, forked_from_id: null, timestamp, cwd: root,
    originator: 'agentmux_private_native_fixture', cli_version: '0.159.2', source: 'cli',
    model_provider: 'fixture_provider', history_mode: 'paginated',
    base_instructions: { text: 'Synthetic offline native history fixture.' }
  } }]
  const event = payload => records.push({ ordinal: records.length, timestamp, type: 'event_msg', payload })
  const turnId = 'synthetic-turn-1'
  event({ type: 'task_started', turn_id: turnId, started_at: 10, model_context_window: null })
  for (let i = 1; i <= count; i++) event({
    type: 'item_completed', thread_id: threadId, turn_id: turnId,
    started_at_ms: 0, completed_at_ms: i,
    item: { type: 'AgentMessage', id: `synthetic-agent-${i}`,
      content: [{ type: 'Text', text: `Synthetic private record ${i}.` }] }
  })
  event({ type: 'task_complete', turn_id: turnId, last_agent_message: null,
    started_at: 10, completed_at: 20, duration_ms: 10_000 })
  await writeFile(rollout, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const originalRolloutSha256 = sha256(await readFile(rollout))
  const prepared = await withNativeHelper({ nativeCommand, home, cwd: root, purpose: 'prepare-native-writer' }, async request => {
    const response = await request('thread/resume', {
      threadId, path: rollout, excludeTurns: true,
      model: 'fixture-model', modelProvider: 'fixture_provider',
      sandbox: 'read-only', approvalPolicy: 'never'
    })
    assert.equal(response.thread.id, threadId)
    assert.equal(response.thread.historyMode, 'paginated')
    return { id: response.thread.id, historyMode: response.thread.historyMode }
  })
  assert.deepEqual(prepared.receipt.methods, ['initialize', 'thread/resume'])
  assert.equal(prepared.receipt.forcedCleanup, undefined)
  assert.equal(prepared.receipt.exit.code, 0)
  return { home, threadId, rollout, nativeCommand,
    fixture: { canonicalRecords: records.length, completedItems: count, originalRolloutSha256,
      postPreparationRolloutSha256: sha256(await readFile(rollout)), formatSourceTag: 'rust-v0.159.2' },
    preparation: prepared.receipt }
}
