import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { parseRoutedConversationPage } from '@agentmux/core/conversation'
import * as stream from '../../core/dist/conversation-stream.js'
import { PublicationHost } from '../src/publication-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { roomBindingFixture, context } from './fixtures/room-binding.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'

const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks() } })

it.each(['item', 'fragment'] as const)('real publication preserves the %s validation boundary through Core, Host and Store', async representation => {
  const remote = await feishuPublicationHttp(); closes.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http })
  const f = await roomBindingFixture(true, { adapters: [adapter], retired: false, config: feishuConfig, secrets: { resolve: async () => 'isolated-credential' } }); closes.push(f.close)
  const port = createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }])
  const bound = await f.bindings.bind(f.input, context)
  if (bound.state !== 'applied') throw Error('Original binding was not applied')
  let fragments = 0
  const host = new PublicationHost({ connections: f.connections, bindings: f.bindings, conversation: { ...port,
    changes: async (input, signal) => {
      const page = await port.changes({ ...input, ...(representation === 'fragment' ? { maxBytes: 16_384 } : {}) }, signal)
      fragments += page.items.filter(entry => entry.kind === 'fragment').length
      // A narrow inner read exercises real fragment assembly without allocating a multi-MiB body.
      // The existing route parser still checks the outer consumer's original envelope and budget.
      return representation === 'fragment' ? parseRoutedConversationPage(page, { ...page, budgetBytes: input.maxBytes }, input) : page
    }
  } }); closes.push(() => host.close())
  const digest = vi.spyOn(stream, 'conversationRevision'), commit = host.store.commitPage.bind(host.store)
  const costs: Array<{ units: number; owned: number; digests: number }> = []
  vi.spyOn(host.store, 'commitPage').mockImplementation((boundary, after, page, authorized, options) => {
    const owned = new Set(page.items.flatMap(entry => entry.kind === 'item' ? [entry.item] : []))
    const before = digest.mock.calls.length
    commit(boundary, after, page, authorized, options)
    if (options.units.length) costs.push({ units: options.units.length, owned: options.units.filter(unit => owned.has(unit)).length, digests: digest.mock.calls.length - before })
  })
  const text = representation === 'fragment' ? 'Original public reply '.repeat(1_500) : 'Original public reply'
  await appendFile(f.transcript, JSON.stringify({ sessionId: 'original-native', uuid: 'new-original-reply', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
  host.refresh()
  await vi.waitFor(() => {
    const operations = host.store.list(bound.binding)
    expect(operations.length).toBeGreaterThan(0)
    expect(operations.every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 15_000 })
  expect(costs.length).toBeGreaterThan(0)
  if (representation === 'item') {
    expect(fragments).toBe(0)
    expect(costs.every(cost => cost.owned === cost.units && cost.digests === 0), JSON.stringify(costs)).toBe(true)
  } else {
    expect(fragments).toBeGreaterThan(1)
    expect(costs.some(cost => cost.owned < cost.units && cost.digests > 0), JSON.stringify(costs)).toBe(true)
  }
  expect(JSON.stringify([...remote.records.values()])).toContain('Original public reply')
  expect(f.client.connect).not.toHaveBeenCalled()
}, 20_000)
