import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionSecrets } from '../src/connection-secrets.js'
import { createConnectionServices } from '../src/connection-services.js'
import type { PublicationConversationPort } from '../src/publication-host.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close() }
  finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

it('keeps one receive/publication owner while independent management reads remain available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-channel-owner-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const noSource = vi.fn(async () => { throw Error('An empty binding owner cannot read a conversation') })
  const publication: PublicationConversationPort = { checkpoint: noSource, changes: noSource, inspect: noSource, observe: noSource, notification: noSource, message: noSource }
  const options = { directory, adapters: [], publication,
    bindings: { spatial: { read: async () => null }, checkpoint: noSource } }
  const first = await createConnectionServices(options); cleanup.push(() => first.close())
  const second = await createConnectionServices(options); cleanup.push(() => second.close())
  expect(first.database).not.toBeNull(); expect(second.database).toBeNull()
  await expect(second.connections.list()).rejects.toMatchObject({ code: 'CONNECTION_OWNER_BUSY' })
  expect(await first.connections.list()).toEqual({ connections: [] })
  const reader = await createConnectionServices({ directory, adapters: [] }); cleanup.push(() => reader.close())
  expect(await reader.connections.list()).toEqual({ connections: [] })
  expect(noSource).not.toHaveBeenCalled()
  await first.close()
  expect(await second.connections.list()).toEqual({ connections: [] })
  expect(second.database).not.toBeNull()
})

it('reacquires the same background database after its previous owner exits without a client read', async () => {
  vi.useFakeTimers()
  const directory = await mkdtemp(join(tmpdir(), 'amux-channel-recovery-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const noSource = vi.fn(async () => { throw Error('No source exists') })
  const options = { directory, adapters: [],
    publication: { checkpoint: noSource, changes: noSource, inspect: noSource, observe: noSource, notification: noSource, message: noSource },
    bindings: { spatial: { read: async () => null }, checkpoint: noSource } }
  const first = await createConnectionServices(options); cleanup.push(() => first.close())
  const second = await createConnectionServices(options); cleanup.push(() => second.close())
  expect(second.database).toBeNull()
  await first.close()
  await vi.advanceTimersByTimeAsync(5_000)
  await vi.waitFor(() => expect(second.database).not.toBeNull())
  expect(noSource).not.toHaveBeenCalled()
  await second.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('forwards current administration authority through the real facade after a secure-backend wait', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-channel-entry-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  let release!: () => void, reached = false, authorized = true
  const held = new Promise<void>(resolve => { release = resolve })
  // Delay only the original private storage observation; the facade must retain its current-authority callback.
  const available = ConnectionSecrets.prototype.assertAvailable
  vi.spyOn(ConnectionSecrets.prototype, 'assertAvailable').mockImplementationOnce(async function () { reached = true; await held; await available.call(this) })
  const owner = await createConnectionServices({ directory, adapters: [] }); cleanup.push(() => owner.close())
  const write = owner.secrets.store({ operationId: 'original-entry', secret: 'synthetic-value' }, () => {
    if (!authorized) throw new AgentMuxError('The original operator was revoked.', 'CONTROL_PERMISSION_DENIED')
  })
  const outcome = write.then(value => ({ value }), error => ({ error }))
  try { await vi.waitFor(() => expect(reached).toBe(true)); authorized = false }
  finally { release() }
  expect(await outcome).toMatchObject({ error: { code: 'CONTROL_PERMISSION_DENIED' } })
  expect(await owner.secrets.inspect('original-entry')).toBeNull()
})
