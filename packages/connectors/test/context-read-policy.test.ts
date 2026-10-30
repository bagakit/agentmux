import { afterEach, expect, it, vi } from 'vitest'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { DiscordAdapter } from '../src/adapters/discord/index.js'
import { feishuConfig } from './fixtures/feishu.js'
import { discordConfig } from './fixtures/discord.js'
import { feishuHistoryMessage as fm, feishuHistoryTransport, discordHistoryMessage as dm } from './fixtures/channel-history.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers() })
const range = { from: { messageId: 'from', inclusive: false }, throughMessageId: 'through', origin: 'admitted-input' as const }
function clock() {
  vi.useFakeTimers({ now: fixtureEpoch(2), toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // Drive only the policy clock; real AbortControllers and the pinned SDK still carry cancellation.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Readonly observation window ended', 'TimeoutError')), ms).unref?.()
    return controller.signal
  })
}

it('Feishu keeps a complete slow multi-page quote whose total exceeds one HTTP observation window', async () => {
  clock()
  const rows = [fm('through', 100000), ...Array.from({ length: 111 }, (_, i) => fm('middle-' + i, 2000 + i * 100)).toReversed(), fm('from', 1000)]
  const transport = feishuHistoryTransport(rows), original = transport.request.getMockImplementation()!
  const adapter = new FeishuAdapter({ http: transport.http }); cleanup.push(() => adapter.close())
  transport.request.mockImplementation(input => new Promise(resolve => { setTimeout(() => resolve(original(input)), 10_000) }))
  const start = Date.now()
  let result: Awaited<ReturnType<typeof adapter.readHistory>> | undefined
  const work = adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range }, 'private-credential', new AbortController().signal).then(value => { result = value })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(result).toMatchObject({ coverage: 'complete', gaps: [] })
  expect(result!.records).toHaveLength(111)
  expect(result!.observedAt - start).toBeGreaterThan(15_000)
  expect(transport.requests.filter(request => request.params?.container_id_type === 'chat')).toHaveLength(3)
  await work
})

it('Feishu ends only the held token observer and a late token cannot replace the other caller cache', async () => {
  clock()
  const transport = feishuHistoryTransport([fm('through', 10000), fm('from', 1000)])
  const adapter = new FeishuAdapter({ http: transport.http }); adapter.setClientRetention(() => true)
  const outer = new AbortController(); cleanup.push(() => { outer.abort(); adapter.close() })
  let tokenCalls = 0, heldSignal: AbortSignal | undefined, release!: () => void
  const authorizations: unknown[] = []
  transport.override(input => {
    const request = input as typeof input & { signal?: AbortSignal; headers?: Record<string, unknown> }
    if (request.url?.includes('/auth/v3/')) {
      tokenCalls++
      if (tokenCalls === 1) { heldSignal = request.signal; return new Promise(resolve => { release = () => resolve({ code: 0, tenant_access_token: 'late-old-token', expire: 7200 }) }) }
    }
    if (request.url?.endsWith('/messages/through')) authorizations.push(request.headers?.Authorization ?? request.headers?.authorization)
  })
  let result: Awaited<ReturnType<typeof adapter.readHistory>> | undefined
  const held = adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range }, 'private-credential', outer.signal).then(value => { result = value })
  await vi.waitFor(() => expect(heldSignal).toBeDefined())
  const healthy = await adapter.withClient(feishuConfig, 'private-credential', client => client.request({ method: 'GET', url: '/open-apis/im/v1/messages/through' }))
  expect(healthy).toHaveProperty('code', 0); expect(tokenCalls).toBe(2)
  await vi.advanceTimersByTimeAsync(15_001)
  expect(result).toMatchObject({ coverage: 'unavailable', gaps: [{ reason: 'native-history-observation-expired' }] })
  expect(heldSignal!.aborted).toBe(true); expect(outer.signal.aborted).toBe(false)
  release(); await held
  await adapter.withClient(feishuConfig, 'private-credential', client => client.request({ method: 'GET', url: '/open-apis/im/v1/messages/through' }))
  expect(tokenCalls).toBe(2)
  expect(authorizations).toHaveLength(2)
  expect(authorizations.every(value => typeof value === 'string' && !value.includes('late-old-token'))).toBe(true)
})

it('Feishu honors the exact request signal even with a healthy enclosing caller lifetime', async () => {
  const transport = feishuHistoryTransport([fm('through', 10000)]), adapter = new FeishuAdapter({ http: transport.http })
  const lifetime = new AbortController(), request = new AbortController(); cleanup.push(() => { lifetime.abort(); adapter.close() })
  let nativeSignal: AbortSignal | undefined, release!: () => void
  transport.override(input => {
    if (!input.url?.endsWith('/messages/through')) return
    nativeSignal = (input as { signal?: AbortSignal }).signal
    return new Promise((resolve, reject) => {
      release = () => resolve({ code: 0 })
      nativeSignal?.addEventListener('abort', () => reject(Error('Exact native read aborted')), { once: true })
    })
  })
  const work = adapter.withClient(feishuConfig, 'private-credential', client => client.request({ method: 'GET', url: '/open-apis/im/v1/messages/through', signal: request.signal } as never), lifetime.signal).catch(error => error)
  await vi.waitFor(() => expect(nativeSignal).toBeDefined())
  request.abort()
  expect(nativeSignal!.aborted).toBe(true); expect(lifetime.signal.aborted).toBe(false)
  release(); await work
})

it('Feishu generic SDK business calls do not acquire a history observation deadline', async () => {
  clock()
  const transport = feishuHistoryTransport([]), adapter = new FeishuAdapter({ http: transport.http })
  cleanup.push(() => adapter.close())
  let nativeSignal: AbortSignal | undefined, release!: () => void, completed: unknown
  transport.override(input => {
    if (!input.url?.endsWith('/im/v1/messages')) return
    nativeSignal = (input as { signal?: AbortSignal }).signal
    return new Promise(resolve => { release = () => resolve({ code: 0, data: { message_id: 'original-private-write' } }) })
  })
  const work = adapter.withClient(feishuConfig, 'private-credential', client => client.request({ method: 'POST', url: '/open-apis/im/v1/messages', data: { content: 'Private protocol write fixture' } })).then(value => { completed = value }, error => { completed = error })
  await vi.waitFor(() => expect(release).toBeDefined())
  await vi.advanceTimersByTimeAsync(30_001)
  expect(completed).toBeUndefined(); expect(nativeSignal?.aborted ?? false).toBe(false)
  release(); await work
  expect(completed).toMatchObject({ code: 0, data: { message_id: 'original-private-write' } })
})

it('Discord keeps its native REST scheduler and complete slow pages across independent read windows', async () => {
  clock()
  const rows = Array.from({ length: 205 }, (_, i) => dm(String(1000 - i)))
  const calls: string[] = []
  const adapter = new DiscordAdapter({ http: { makeRequest: async (url, init) => {
    const request = new URL(url), path = request.pathname.replace('/api/v10', ''); calls.push(path)
    await new Promise(resolve => setTimeout(resolve, 10_000))
    const value = path === '/oauth2/applications/@me' ? { id: '100', flags: 524288, bot: { id: '200' } }
      : path === '/channels/300/messages' ? rows.filter(row => BigInt(row.id) < BigInt(request.searchParams.get('before')!)).slice(0, 100)
        : rows.find(row => row.id === path.split('/').at(-1))
    expect(init.signal?.aborted).toBe(false)
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }) as never
  } } }); cleanup.push(() => adapter.close())
  const start = Date.now()
  let result: Awaited<ReturnType<typeof adapter.readHistory>> | undefined
  const work = adapter.readHistory(discordConfig, { externalConversationId: '300', range: { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' } }, 'private-token', new AbortController().signal).then(value => { result = value })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(result).toMatchObject({ coverage: 'complete', gaps: [] })
  expect(result!.records).toHaveLength(199); expect(result!.observedAt - start).toBeGreaterThan(15_000)
  expect(calls.filter(path => path === '/channels/300/messages')).toHaveLength(2)
  await work
})

it('Feishu retains the confirmed page prefix and a late uncooperative page cannot continue history', async () => {
  clock()
  const rows = [fm('through', 100000), ...Array.from({ length: 111 }, (_, i) => fm('middle-' + i, 2000 + i * 100)).toReversed(), fm('from', 1000)]
  const transport = feishuHistoryTransport(rows), adapter = new FeishuAdapter({ http: transport.http })
  cleanup.push(() => adapter.close())
  let heldSignal: AbortSignal | undefined, release!: () => void
  transport.override(input => {
    if (input.params?.page_token !== '50') return
    heldSignal = (input as { signal?: AbortSignal }).signal
    return new Promise(resolve => { release = () => resolve({ code: 0, data: { items: rows.slice(50, 100), has_more: true, page_token: '100' } }) })
  })
  let result: Awaited<ReturnType<typeof adapter.readHistory>> | undefined
  const work = adapter.readHistory(feishuConfig, { externalConversationId: 'original-room', range }, 'private-credential', new AbortController().signal).then(value => { result = value })
  await vi.waitFor(() => expect(heldSignal).toBeDefined())
  await vi.advanceTimersByTimeAsync(15_001)
  expect(result).toMatchObject({ coverage: 'partial', gaps: [{ reason: 'native-history-observation-expired' }] })
  expect(result!.records.length).toBeGreaterThan(0); expect(heldSignal!.aborted).toBe(true)
  const frozen = JSON.stringify(result)
  release(); await work; await vi.advanceTimersByTimeAsync(100)
  expect(JSON.stringify(result)).toBe(frozen)
  expect(transport.requests.filter(input => input.params?.container_id_type === 'chat')).toHaveLength(2)
})

it('Discord releases an uncooperative exact page and keeps its confirmed prefix after late settlement', async () => {
  clock()
  const rows = Array.from({ length: 205 }, (_, i) => dm(String(1000 - i)))
  let pages = 0, heldSignal: AbortSignal | undefined, release!: () => void
  const adapter = new DiscordAdapter({ http: { makeRequest: async (url, init) => {
    const request = new URL(url), path = request.pathname.replace('/api/v10', '')
    let value: unknown
    if (path === '/oauth2/applications/@me') value = { id: '100', flags: 524288, bot: { id: '200' } }
    else if (path === '/channels/300/messages') {
      pages++
      value = rows.filter(row => BigInt(row.id) < BigInt(request.searchParams.get('before')!)).slice(0, 100)
      if (pages === 2) { heldSignal = init.signal ?? undefined; await new Promise<void>(resolve => { release = resolve }) }
    } else value = rows.find(row => row.id === path.split('/').at(-1))
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }) as never
  } } }); cleanup.push(() => adapter.close())
  let result: Awaited<ReturnType<typeof adapter.readHistory>> | undefined
  const work = adapter.readHistory(discordConfig, { externalConversationId: '300', range: { from: { messageId: '800', inclusive: false }, throughMessageId: '1000', origin: 'admitted-input' } }, 'private-token', new AbortController().signal).then(value => { result = value })
  await vi.waitFor(() => expect(heldSignal).toBeDefined())
  await vi.advanceTimersByTimeAsync(15_001)
  expect(result).toMatchObject({ coverage: 'partial', gaps: [{ reason: 'native-history-observation-expired' }] })
  expect(result!.records).toHaveLength(100); expect(heldSignal!.aborted).toBe(true)
  const frozen = JSON.stringify(result)
  release(); await work; await vi.advanceTimersByTimeAsync(100)
  expect(JSON.stringify(result)).toBe(frozen); expect(pages).toBe(2)
})
