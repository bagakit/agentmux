import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { HOOK_REQUEST_TIMEOUT_MS, HOOK_RETRY_DELAY_MS, requestHookPermissionDecision } from '../src/agent-hook-delivery.js'
import { AgentHookServer } from '../src/hook-server.js'
import type { NativeHookEnvelope } from '../src/types.js'

const servers: AgentHookServer[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => server.stop())) })
async function fixture() {
  const events: NativeHookEnvelope[] = [], closed: Array<{ receiptId: string; decided: boolean }> = []
  let delivered!: () => void
  const observed = new Promise<void>(resolve => { delivered = resolve })
  const server = new AgentHookServer(event => { events.push(event); if (event.permissionCallback) delivered(); return { permissionCallbackAccepted: true } }, 0,
    undefined, (provider, event) => provider === 'codex' && event === 'PermissionRequest',
    (_session, _run, receiptId, decided) => { closed.push({ receiptId, decided }) })
  servers.push(server); await server.start()
  const binding = server.createBinding('session', 'codex'); await binding.bindRun('run')
  const post = (id: string, decision = true, signal?: AbortSignal) => fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId: id, eventName: decision ? 'PermissionRequest' : 'PostToolUse', payload: { tool_name: 'Bash' }, ...(decision ? { decision: true } : {}) }), ...(signal ? { signal } : {})
  })
  return { server, binding, events, observed, closed, post }
}

it('holds only the original permission callback; unrelated events keep their original lane', async () => {
  const h = await fixture(), pending = h.post('original')
  await h.observed
  expect(h.server.hasPermissionCallback('session', 'run', 'original')).toBe(true)
  expect((await h.post('observer', false)).status).toBe(204)
  expect(h.events.map(event => event.receiptId)).toEqual(['original', 'observer'])
  const output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  await h.server.respondPermission('session', 'run', 'original', output)
  expect(await (await pending).json()).toEqual(output)
  await expect.poll(() => h.closed).toEqual([{ receiptId: 'original', decided: true }])
  expect(h.server.hasPermissionCallback('session', 'run', 'original')).toBe(false)
  await expect(h.server.respondPermission('session', 'run', 'original', output)).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
})

it('cannot replace an original callback or send its decision to a different Run', async () => {
  const h = await fixture(), pending = h.post('original')
  await h.observed
  expect((await h.post('original')).status).toBe(409)
  await expect(h.server.respondPermission('session', 'different-run', 'original', { allow: true })).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
  expect(h.events).toHaveLength(1)
  await h.server.respondPermission('session', 'run', 'original', null)
  expect(await (await pending).json()).toEqual({})
  await expect.poll(() => h.closed).toEqual([{ receiptId: 'original', decided: false }])
})

it.each(['binding', 'server'])('%s shutdown abstains and drains without waiting for a human', async owner => {
  const h = await fixture(), pending = h.post('original')
  await h.observed
  if (owner === 'binding') await h.binding.close()
  else await h.server.stop()
  expect(await (await pending).json()).toEqual({})
  expect(h.server.hasPermissionCallback('session', 'run', 'original')).toBe(false)
  expect(h.events).toHaveLength(1)
})

it('the original peer disconnect only closes that callback and cannot silently approve', async () => {
  const h = await fixture(), controller = new AbortController(), pending = h.post('original', true, controller.signal)
  const outcome = pending.then(response => response.text()).catch(error => error)
  await h.observed; controller.abort()
  expect((await outcome).name).toBe('AbortError')
  await expect.poll(() => h.closed).toEqual([{ receiptId: 'original', decided: false }])
  expect((await h.post('observer', false)).status).toBe(204)
})

it('an owner which did not adopt the original callback immediately abstains', async () => {
  const server = new AgentHookServer(() => {}, 0, undefined, () => true)
  servers.push(server); await server.start()
  const binding = server.createBinding('unadopted', 'codex'); await binding.bindRun('run')
  const response = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` },
    body: JSON.stringify({ receiptId: 'no-consumer', eventName: 'PermissionRequest', decision: true, payload: {} }) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({})
  expect(server.hasPermissionCallback('unadopted', 'run', 'no-consumer')).toBe(false)
})


it('a candidate on a Provider without a decision declaration stays an ordinary observation', async () => {
  const events: NativeHookEnvelope[] = []
  const server = new AgentHookServer(event => { events.push(event) }, 0, undefined, () => false)
  servers.push(server); await server.start()
  const binding = server.createBinding('observer', 'claude'); await binding.bindRun('run')
  const body = JSON.stringify({ receiptId: 'willing-only', eventName: 'PermissionRequest', decision: true, payload: {} })
  expect(await requestHookPermissionDecision(binding.endpoint.url, binding.endpoint.token, body)).toEqual({})
  expect(events).toHaveLength(1)
  expect(events[0]).not.toHaveProperty('permissionCallback')
  expect(server.hasPermissionCallback('observer', 'run', 'willing-only')).toBe(false)
  const retry = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` }, body })
  expect(retry.status).toBe(204)
  expect(events).toHaveLength(1)
})

it.each(['unconfirmed', 'decision'])('keeps the bounded observer phase until the same response confirms %s mode', async mode => {
  let arrived!: () => void, response!: import('node:http').ServerResponse
  const observed = new Promise<void>(resolve => { arrived = resolve })
  const server = createServer((_request, reply) => {
    response = reply
    if (mode === 'decision') {
      reply.writeHead(200, { 'x-agentmux-hook-mode': 'decision' }); reply.flushHeaders()
    }
    arrived()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No actual listener')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = requestHookPermissionDecision(`http://127.0.0.1:${address.port}`, 'private', '{}')
  const observedResult = pending.then(value => ({ value }), error => ({ error }))
  try {
    await observed
    if (mode === 'decision') {
      // Node I/O stays real; wait for the response callback to retire its exact initial timer.
      for (let turn = 0; turn < 100 && vi.getTimerCount() > 0; turn++) await new Promise<void>(resolve => setImmediate(resolve))
      expect(vi.getTimerCount()).toBe(0)
    }
    await vi.advanceTimersByTimeAsync(HOOK_REQUEST_TIMEOUT_MS + HOOK_RETRY_DELAY_MS + 1)
    if (mode === 'decision') {
      response.end('{"original":true}')
      expect(await observedResult).toEqual({ value: { original: true } })
    } else {
      expect(await observedResult).toMatchObject({ error: { message: expect.stringContaining('mode was not confirmed') } })
    }
  } finally {
    vi.useRealTimers(); response?.destroy(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})


it('the original managed worker offers stdout for an exact custom Provider event without a global event-name assumption', async () => {
  let observed!: (event: NativeHookEnvelope) => void
  const arrived = new Promise<NativeHookEnvelope>(resolve => { observed = resolve })
  const server = new AgentHookServer(event => { observed(event); return { permissionCallbackAccepted: true } }, 0,
    undefined, (_provider, event) => event === 'ApproveExecution')
  servers.push(server); await server.start()
  const binding = server.createBinding('custom-owner', 'custom'); await binding.bindRun('custom-run')
  const env = { ...process.env, AGENTMUX_ENV: '1', AGENTMUX_HOOK_URL: binding.endpoint.url,
    AGENTMUX_HOOK_TOKEN: binding.endpoint.token, AGENTMUX_HOOK_PROVIDER: 'custom' }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/agentmux-hook.js', import.meta.url)), '--event', 'ApproveExecution'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const closed = once(child, 'close'); child.stdin.end('{}')
  try {
    const event = await arrived
    expect(event.eventName).toBe('ApproveExecution')
    expect(event.permissionCallback).toBe(true)
    await server.respondPermission('custom-owner', 'custom-run', event.receiptId, { exactCustomDecision: 'allow' })
    expect(await closed).toEqual([0, null])
    expect({ stdout, stderr }).toEqual({ stdout: '{"exactCustomDecision":"allow"}\n', stderr: '' })
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed } }
})


it.each(['observer', 'observer-failure', 'unknown', 'decision'])('only a confirmed %s mode may retry the original observation receipt', async mode => {
  const bodies: string[] = []
  const server = createServer(async (request, reply) => {
    let body = ''; for await (const chunk of request) body += chunk
    bodies.push(body)
    if (mode === 'observer' && bodies.length === 2) { reply.writeHead(204, { 'x-agentmux-hook-mode': 'observer' }); reply.end(); return }
    if (mode.startsWith('observer')) { reply.writeHead(503, { 'x-agentmux-hook-mode': 'observer' }); reply.end() }
    else if (mode === 'decision') {
      reply.writeHead(200, { 'x-agentmux-hook-mode': 'decision' }); reply.flushHeaders()
      setImmediate(() => reply.destroy())
    } else reply.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No actual listener')
  const body = JSON.stringify({ receiptId: 'one-original-observation', decision: true, eventName: 'Custom', payload: {} })
  try {
    const result = requestHookPermissionDecision(`http://127.0.0.1:${address.port}`, 'private', body)
    if (mode === 'observer') { expect(await result).toEqual({}); expect(bodies).toEqual([body, body]) }
    else { await expect(result).rejects.toBeInstanceOf(Error); expect(bodies).toEqual(mode === 'observer-failure' ? [body, body] : [body]) }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
