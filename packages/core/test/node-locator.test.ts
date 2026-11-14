import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as current from '../src/node-locator.js'
const { locatePublishedNodes, parseNodeLocateParams, parseNodeLocateResult } = process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT
  ? await import(/* @vite-ignore */pathToFileURL(join(process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT,'dist/node-locator.js')).href) as typeof current : current
import type { NodePublication } from '../src/node-publishing.js'
const publication = (runtimeId: string, alias = 'studio'): NodePublication => ({ node: { runtimeId, alias, ownerInstanceId: runtimeId + '-instance' }, policyRevision: 'policy', resourcesShared: false, roots: [], landing: null })
it('distinguishes observed unique, collision, unknown scope and confirmed absence', async () => {
  const inspect = vi.fn(async (host: string) => { if (host === 'offline') throw Error('/private/transport/path'); return publication(host, host === 'different' ? 'other' : 'studio') })
  expect((await locatePublishedNodes({ alias: 'studio' }, ['one'], inspect)).status).toBe('unique')
  expect((await locatePublishedNodes({ alias: 'studio' }, ['one', 'two'], inspect)).status).toBe('ambiguous')
  const uncertain = await locatePublishedNodes({ alias: 'studio' }, ['one', 'offline'], inspect)
  expect(uncertain.status).toBe('unconfirmed'); expect(uncertain.matches).toHaveLength(1)
  expect(JSON.stringify(uncertain)).not.toContain('/private/transport/path')
  expect((await locatePublishedNodes({ alias: 'studio' }, ['different'], inspect)).status).toBe('missing')
  expect((await locatePublishedNodes({ alias: 'studio' }, ['offline'], inspect)).status).toBe('unconfirmed')
})
it('pins the original Runtime across rename and keeps unrelated unknown scopes visible', async () => {
  const inspect = async (host: string) => { if (host === 'offline') throw Error('unavailable'); return publication(host, 'renamed') }
  const pinned = await locatePublishedNodes({ alias: 'old-name', expectedRuntimeId: 'original' }, ['original', 'offline'], inspect)
  expect(pinned.status).toBe('unique'); expect(pinned.matches[0]?.publication.node.alias).toBe('renamed'); expect(pinned.issues).toHaveLength(1)
  expect((await locatePublishedNodes({ alias: 'renamed', expectedRuntimeId: 'missing-runtime' }, ['original'], inspect)).status).toBe('missing')
})
it('deduplicates original Runtime carriers and prefers confirmed canonical local publication', async () => {
  const inspect = async (host: string) => publication('same-runtime', host === 'local' ? 'studio' : 'old-alias')
  const operation = locatePublishedNodes({ alias: 'studio' }, ['ssh-self', 'local', 'second-carrier'], inspect)
  await expect(operation).resolves.toMatchObject({status:'unique',matches:[{hostId:'local'}]})
  const value = await operation
  expect(value.status).toBe('unique'); expect(value.matches[0]).toEqual({ hostId: 'local', hostIds: ['ssh-self', 'local', 'second-carrier'], publication: publication('same-runtime') })
  const remote = await locatePublishedNodes({ alias: 'old-alias' }, ['first', 'second'], inspect)
  expect(remote.matches[0]?.hostId).toBe('first'); expect(remote.matches[0]?.hostIds).toEqual(['first', 'second'])
})
it('does not query ambiguous route IDs or guess a canonical carrier from unavailable observations', async () => {
  const inspect = vi.fn(async (host: string) => { if (host === 'local') throw Error('offline'); return publication('same-runtime') })
  const result = await locatePublishedNodes({ alias: 'studio' }, ['duplicate', 'duplicate', 'remote', 'local'], inspect)
  expect(result.status).toBe('unconfirmed'); expect(result.matches[0]?.hostId).toBe('remote'); expect(result.matches[0]?.hostIds).toEqual(['remote'])
  expect(inspect.mock.calls.map(call => call[0])).toEqual(['remote', 'local'])
  expect(result.issues.map(issue => issue.hostId)).toEqual(['duplicate', 'local'])
})
it('strictly validates locator input, status, identity and confirmed route membership', async () => {
  for (const input of [{ alias: '' }, { alias: 'UpperCase' }, { alias: 'studio', hostId: 'pretend' }]) expect(() => parseNodeLocateParams(input)).toThrow()
  const value = await locatePublishedNodes({ alias: 'studio' }, ['local'], async () => publication('original'))
  expect(() => parseNodeLocateResult({ ...value, status: 'missing' }, { alias: 'studio' })).toThrow()
  expect(() => parseNodeLocateResult(value, { alias: 'studio', expectedRuntimeId: 'different' })).toThrow()
  expect(() => parseNodeLocateResult({ ...value, matches: [{ ...value.matches[0], hostId: 'unobserved' }] }, { alias: 'studio' })).toThrow()
})
