import { expect, it, vi } from 'vitest'
import { actualRelayOwner, carrierFact } from './helpers/relay-carrier-owner.js'

it('the original encrypted hello confirms its Host before the Hosted bootstrap', async () => {
  const f = await actualRelayOwner(), client = await f.hosted()
  expect((await client.readAgentSessions()).map(session => session.agentSessionId)).toContain('caller')
  const hello = f.requests.filter(value => value.frame.method === 'device.hello')
  expect(hello).toHaveLength(1)
  const reply = f.replies.find(value => value.frame.id === hello[0]!.frame.id)?.frame.result
  expect(reply).toMatchObject({ hostId: f.authority.hostId })
  expect(f.requests.filter(value => ['runtime.events', 'runtime.bootstrap'].includes(value.frame.method ?? ''))).toHaveLength(1)
  expect(f.host.client.agentSession('caller').run).toEqual({ runId: 'run-caller' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'encrypted-original-host', hostId: f.authority.hostId, hello: 1, bootstrap: 1 })
})

it('a foreign encrypted hello Host refuses only that initialization and preserves the healthy peer', async () => {
  const f = await actualRelayOwner(), healthy = await f.hosted()
  await expect.poll(() => f.inFlight()).toBe(0)
  const bootstraps = f.requests.filter(value => ['runtime.events', 'runtime.bootstrap'].includes(value.frame.method ?? '')).length
  const devices = f.authority.devices().map(device => device.deviceId)
  f.reply(async (frame, connection, send) => {
    const request = f.requests.find(value => value.connection === connection && value.frame.id === frame.id)
    if (request?.frame.method === 'device.hello' && frame.result) {
      await send({ ...frame, result: { ...frame.result as object, hostId: 'foreign-encrypted-host' } })
    } else await send(frame)
  })
  const outcome = await f.hosted().then(() => ({ connected: true }), error => ({ error }))
  expect(outcome, 'encrypted hello must confirm the original Host before bootstrap').toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } })
  expect(f.requests.filter(value => ['runtime.events', 'runtime.bootstrap'].includes(value.frame.method ?? ''))).toHaveLength(bootstraps)
  f.reply(undefined)
  expect((await healthy.readAgentSessions()).map(session => session.agentSessionId)).toContain('caller')
  expect(f.authority.devices().map(device => device.deviceId)).toEqual(devices)
  expect(f.host.client.agentSession('caller').run).toEqual({ runId: 'run-caller' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'foreign-hello-refused', bootstrapsAdded: 0, originalRun: 'run-caller', healthyPeerReadable: true })
})

it('the raw RPC hello refuses a foreign Host and retains the original authenticated reader', async () => {
  const f = await actualRelayOwner()
  await expect(f.rpc.call('device.hello', { name: 'original raw reader' })).resolves.toMatchObject({ hostId: f.authority.hostId })
  const devices = f.authority.devices().map(device => device.deviceId)
  f.reply(async (frame, connection, send) => {
    const request = f.requests.find(value => value.connection === connection && value.frame.id === frame.id)
    if (request?.frame.method === 'device.hello' && frame.result) {
      await send({ ...frame, result: { ...frame.result as object, hostId: 'foreign-encrypted-host' } })
    } else await send(frame)
  })
  const outcome = await f.rpc.call('device.hello', { name: 'original raw reader' }).then(() => ({ accepted: true }), error => ({ error }))
  expect(outcome, 'raw encrypted hello must confirm its original endpoint Host').toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } })
  f.reply(undefined)
  await expect(f.rpc.call('agent.ls', {})).resolves.toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ session: expect.objectContaining({ agentSessionId: 'caller' }) })]) })
  expect(f.authority.devices().map(device => device.deviceId)).toEqual(devices)
  expect(f.host.client.agentSession('caller').run).toEqual({ runId: 'run-caller' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  carrierFact({ kind: 'raw-foreign-hello-refused', originalRun: 'run-caller', originalReaderUsable: true })
})
