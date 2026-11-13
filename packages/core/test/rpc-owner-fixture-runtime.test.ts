import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
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

it('connecting through the shared fixture starts no Runtime daemon under its private root', async () => {
  const h = await rpcOwnerFixture(['caller', 'recipient']); closes.push(h.close)
  await h.client.connect()
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(daemonsUnder(h.root), 'a fixture connect must not leave a detached ctxmuxd').toEqual([])
  // Callers keep their own deterministic connect when they need one.
  const kernel = (h.inner.kernel as { connect: (...args: unknown[]) => Promise<void> })
  expect(typeof kernel.connect).toBe('function')
})
