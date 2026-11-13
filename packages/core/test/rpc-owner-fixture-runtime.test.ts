import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

/**
 * The shared public-RPC owner fixture models the Runtime as a deterministic port. Reaching
 * Core connect() through it (an interaction response, a hosted runtime call, a reconnect) must
 * not activate a real ctxmuxd: the real adapter starts a detached daemon, which by product
 * contract outlives its client, so it would outlive the fixture's private root as an orphan.
 */
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0)) await close() })
const daemonsUnder = (root: string) => execFileSync('/bin/ps', ['-axo', 'pid=,command=']).toString().split('\n')
  .filter(line => line.includes('ctxmuxd') && line.includes(`--socket ${root}`))

it('connecting through the shared fixture reaches its deterministic port, not a real Runtime daemon', async () => {
  const h = await rpcOwnerFixture(['caller', 'recipient']); closes.push(h.close)
  const connect = h.inner.kernel.connect as (...args: unknown[]) => Promise<void>
  // The property itself: the fixture replaced the adapter's activation path before any test runs.
  expect(vi.isMockFunction(connect), 'the fixture owns kernel.connect').toBe(true)
  await h.client.connect()
  expect(connect).toHaveBeenCalled()
  // Secondary evidence on this machine: nothing is listening as a ctxmuxd under the private root.
  expect(daemonsUnder(h.root)).toEqual([])
})
