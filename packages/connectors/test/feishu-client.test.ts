import { afterEach, expect, it, vi } from 'vitest'
import type { Client } from '@larksuiteoapi/node-sdk'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { feishuConfig, feishuSdkTransport } from './fixtures/feishu.js'

afterEach(() => vi.restoreAllMocks())

it('reuses one original SDK Client and its token cache for the exact application and credential', async () => {
  const network = feishuSdkTransport(), adapter = new FeishuAdapter({ http: network.http }), clients: Client[] = []
  const read = () => adapter.withClient(feishuConfig, 'fixture-credential', async client => {
    clients.push(client); return await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  })
  await read(); await read()
  expect(clients[0]).toBe(clients[1])
  expect(network.request.mock.calls.filter(([input]) => input.url?.includes('/auth/v3/'))).toHaveLength(1)
  await adapter.withClient(feishuConfig, 'rotated-credential', async client => {
    expect(client).not.toBe(clients[0]); return await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  })
  expect(network.request.mock.calls.filter(([input]) => input.url?.includes('/auth/v3/'))).toHaveLength(2)
  await adapter.withClient({ ...feishuConfig, application: { ...feishuConfig.application, appId: 'another-application' } }, 'rotated-credential', async client => {
    expect(client).not.toBe(clients[0]); return await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  })
  expect(network.request.mock.calls.filter(([input]) => input.url?.includes('/auth/v3/'))).toHaveLength(3)
})

it('shared SDK calls keep independent cancellation and do not retain an earlier caller signal', async () => {
  const network = feishuSdkTransport(), adapter = new FeishuAdapter({ http: network.http })
  await adapter.test(feishuConfig, 'fixture-credential')
  const original = network.request.getMockImplementation()!, signals: AbortSignal[] = []
  network.request.mockImplementation(async input => {
    if (!input.url?.includes('/original-read/')) return original(input)
    const signal = (input as { signal: AbortSignal }).signal; signals.push(signal)
    if (input.url.endsWith('/cancelled')) return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Controlled cancelled HTTP request')), { once: true }))
    return { original: 'healthy read' }
  })
  const abort = new AbortController(), healthy = new AbortController()
  const cancelled = adapter.withClient(feishuConfig, 'fixture-credential', client => client.request({ url: '/original-read/cancelled', method: 'GET' }), abort.signal)
  const retained = adapter.withClient(feishuConfig, 'fixture-credential', client => client.request({ url: '/original-read/healthy', method: 'GET' }), healthy.signal)
  await vi.waitFor(() => expect(signals).toHaveLength(2))
  abort.abort()
  await expect(cancelled).rejects.toMatchObject({ code: 'FEISHU_SDK_REQUEST_FAILED' })
  expect(await retained).toEqual({ original: 'healthy read' })
  expect(signals).toContain(abort.signal); expect(signals).toContain(healthy.signal)
  expect(healthy.signal.aborted).toBe(false)
  expect(await adapter.withClient(feishuConfig, 'fixture-credential', client => client.request({ url: '/original-read/healthy', method: 'GET' }), healthy.signal)).toEqual({ original: 'healthy read' })
})
