import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultRestOptions } from '@discordjs/rest'
import { DiscordAdapter } from '../src/adapters/discord/index.js'
import { TelegramAdapter } from '../src/adapters/telegram/index.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
import { discordConfig, discordTransport } from './fixtures/discord.js'
import { telegramConfig, telegramCredential, telegramTransport } from './fixtures/telegram.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { nativeInputCorrelationKey } from '../../core/src/native-input-correlation.js'
import * as runner from '../../core/src/process-runner.js'

let helperRoot = '', nativeHelper = ''
const nativeProof = process.env.MOTE_CHAT_NATIVE_PROOF
beforeAll(async () => {
  helperRoot = await mkdtemp('/tmp/amx-mote-peer-'); nativeHelper = join(helperRoot, 'native-socket-peer-darwin')
  expect(await runner.runProcess('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    fileURLToPath(new URL('../../core/native/native-socket-peer.c', import.meta.url)), '-o', nativeHelper], { timeoutMs: 10_000 }))
    .toMatchObject({ exitCode: 0, stderr: '' })
  if (nativeProof) {
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    await appendFile(nativeProof, JSON.stringify({ kind: 'native-helper', platform: process.platform, arch: process.arch,
      sourceSHA256: sha(await readFile(new URL('../../core/native/native-socket-peer.c', import.meta.url))), binarySHA256: sha(await readFile(nativeHelper)) }) + '\n')
  }
})
beforeEach(() => {
  const actual = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation(async (command, args, options) => {
    const exactHelper = command.endsWith('/native-socket-peer-darwin'), result = await actual(exactHelper ? nativeHelper : command, args, options)
    if (nativeProof && exactHelper && args[0] === '--process-identity' && result.exitCode === 0)
      await appendFile(nativeProof, JSON.stringify({ kind: 'native-process', identity: JSON.parse(result.stdout) }) + '\n')
    return result
  })
})
afterAll(async () => { if (helperRoot) await rm(helperRoot, { recursive: true, force: true }) })

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const until = <T>(read: () => T | Promise<T>) => vi.waitFor(read, { timeout: 5_000 })
async function originalNativeInput(f: Awaited<ReturnType<typeof moteChatJourneyFixture>>, record: Awaited<ReturnType<typeof f.records>>[number]) {
  const input = record.input!, source = (await f.client.readAgentSession(input.agentSessionId))!.nativeHandle!
  if (source.kind !== 'provider') throw Error('The original native source is missing')
  expect(f.nativeInputs()).toHaveLength(1)
  expect(f.nativeInputs()[0]).toMatchObject({ type: 'user', session_id: source.sessionId })
  expect(nativeInputCorrelationKey(f.nativeInputs()[0]!.uuid)).toEqual({ kind: 'message', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, messageId: input.messageId })
  expect(f.nativeInputs()[0]!.message.content).toContain(record.body)
  await until(async () => {
    const admission = (await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt?.admission?.admission
    expect(admission, JSON.stringify(admission)).toMatchObject({ transport: 'native', native: { plan: { threadId: source.sessionId, clientCorrelation: f.nativeInputs()[0]!.uuid } } })
  })
}

it('native Feishu direct SDK intake keeps creator-null zero closed, then exact compiled CLI allocation reaches Core and original publication', async () => {
  const sdk = feishuSdkTransport(), http = await feishuPublicationHttp(call => call.path.includes('/application/v6/')
    ? { status: 200, body: { code: 210006 } } : undefined)
  cleanup.push(http.close)
  const f = await moteChatJourneyFixture(0, 60_000, 'headless', false, 'claude', undefined, undefined, 'signed-room', 'local', {
    adapter: new FeishuAdapter({ http: http.http }), application: feishuConfig.application, credential: 'fixture-credential'
  })
  await until(() => expect(sdk.sockets.length).toBeGreaterThan(0))
  expect(await f.cli('inspect', { target: f.target })).toMatchObject({ configuration: { creator: null, values: { enabled: true, strangerMessageLimit: 0 } } })
  const payload = feishuPayload({ chat_type: 'p2p', mentions: [], content: JSON.stringify({ text: 'Finite native Feishu question' }) })
  await sdk.receive(payload)
  await until(async () => expect((await f.records())[0]).toMatchObject({ state: 'refused', conversationKind: 'direct', code: 'MOTE_CHAT_QUOTA_EXHAUSTED' }))
  expect(sdk.ack()).toContainEqual({ code: 200 })
  expect(f.start).not.toHaveBeenCalled()
  const audience = await f.cli('audience', { target: f.target }), person = audience.people[0]
  expect(person).toMatchObject({ actor: { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' }, creator: false, total: 0, used: 0 })
  expect(await f.cli('allocate', { operationId: 'finite-feishu-allowance', target: f.target, expectedConfigurationRevision: 1, actor: person.actor, expectedPersonRevision: person.revision, total: 1 })).toMatchObject({ person: { total: 1, used: 0 } })
  const wrong = await f.cliRaw('allocate', { operationId: 'stale-feishu-allowance', target: f.target, expectedConfigurationRevision: 1, actor: person.actor, expectedPersonRevision: person.revision, total: 9 })
  expect(wrong.code).not.toBe(0); expect(wrong.stdout + wrong.stderr).toContain('MOTE_CHAT_REVISION_CONFLICT')
  const accepted = structuredClone(payload); accepted.header.event_id = 'accepted-native-event'; accepted.event.message.message_id = 'accepted-native-message'
  await sdk.receive(accepted)
  let record: Awaited<ReturnType<typeof f.records>>[number] | undefined
  await until(async () => { record = (await f.records()).find(row => row.externalMessageId === accepted.event.message.message_id); expect(record?.state).toBe('claimed') })
  await until(async () => expect(f.nativeInputs(), JSON.stringify({ errors: f.submissionErrors, receipt: await f.services.ingress!.inspect({ ingressId: record!.ingressId }) })).toHaveLength(1))
  expect(record?.input?.author.actor).toEqual(person.actor)
  await originalNativeInput(f, record!)
  await f.reply(record!.input!.agentSessionId, 'native-feishu-reply', 'Exact finite Feishu answer'); f.services.publication!.refresh()
  await until(() => expect(http.calls.some(call => call.method === 'POST' && call.body.includes('Exact finite Feishu answer'))).toBe(true))
  await sdk.receive(accepted)
  expect((await f.cli('audience', { target: f.target })).people[0]).toMatchObject({ creator: false, total: 1, used: 1, remaining: 0 })
  expect(await f.cli('diagnose', { target: f.target })).toMatchObject({ configuration: { enabled: true, revision: 1 } })
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('native Discord direct Gateway MESSAGE_CREATE without creator proof admits one finite guest and publishes to that original direct channel', async () => {
  const wire = await discordTransport(); cleanup.push(wire.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(wire.http.makeRequest)
  const f = await moteChatJourneyFixture(1, 60_000, 'headless', false, 'claude', undefined, undefined, 'signed-room', 'local', {
    adapter: new DiscordAdapter(), application: discordConfig.application, credential: 'fixture-bot-token'
  })
  await until(() => expect(wire.sessions.length).toBeGreaterThan(0))
  const message = wire.message('770', 'Finite Discord direct input', { guild_id: undefined, mentions: [] })
  let record: Awaited<ReturnType<typeof f.records>>[number] | undefined
  await until(async () => { record = (await f.records()).find(row => row.externalMessageId === message.id); expect(record?.state).toBe('claimed') })
  await until(async () => expect(f.nativeInputs(), JSON.stringify({ errors: f.submissionErrors, receipt: await f.services.ingress!.inspect({ ingressId: record!.ingressId }) })).toHaveLength(1))
  expect(record).toMatchObject({ conversationKind: 'direct', actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' } })
  expect((await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration?.creator).toBeNull()
  await originalNativeInput(f, record!)
  await f.reply(record!.input!.agentSessionId, 'native-discord-reply', 'Exact finite Discord answer'); f.services.publication!.refresh()
  await until(() => expect(wire.calls.some(call => call.method === 'POST' && call.path === '/channels/300/messages' && call.body.includes('Exact finite Discord answer'))).toBe(true))
  wire.message('770', message.content, { guild_id: undefined, mentions: [] })
  wire.message('771', 'Exhausted direct input', { guild_id: undefined, mentions: [] })
  await until(async () => expect((await f.records()).find(row => row.externalMessageId === '771')).toMatchObject({ state: 'refused', code: 'MOTE_CHAT_QUOTA_EXHAUSTED' }))
  expect((await f.sdk.call('space.mote.chat.audience', { target: f.target })).people).toMatchObject([{ creator: false, total: 1, used: 1, remaining: 0 }])
  expect(f.start).toHaveBeenCalledOnce(); expect(f.nativeInputs()).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('native Telegram private long-poll Update without creator proof reaches Core and keeps finite quota and original publication through owner reopen', async () => {
  const wire = await telegramTransport(); cleanup.push(wire.close)
  const nativeFetch = fetch
  const adapter = new TelegramAdapter({ fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    expect(url.origin).toBe('https://api.telegram.org')
    return await nativeFetch(wire.origin + url.pathname + url.search, init)
  } })
  const f = await moteChatJourneyFixture(1, 60_000, 'headless', false, 'claude', undefined, undefined, 'signed-room', 'local', {
    adapter, application: telegramConfig.application, credential: telegramCredential
  })
  await until(() => expect(wire.calls.some(call => call.method === 'getUpdates' && call.body.timeout === 30)).toBe(true))
  const update = wire.message('Finite Telegram private input', { chatId: 400, chatType: 'private', mention: false })
  let record: Awaited<ReturnType<typeof f.records>>[number] | undefined
  await until(async () => { record = (await f.records()).find(row => row.externalMessageId === '400:' + update.message!.message_id); expect(record?.state).toBe('claimed') })
  await until(async () => expect(f.nativeInputs(), JSON.stringify({ errors: f.submissionErrors, receipt: await f.services.ingress!.inspect({ ingressId: record!.ingressId }) })).toHaveLength(1))
  expect(record).toMatchObject({ conversationKind: 'direct', actor: { application: telegramConfig.application, idType: 'user_id', userId: '400' } })
  expect((await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration?.creator).toBeNull()
  await originalNativeInput(f, record!)
  await f.restart()
  await f.reply(record!.input!.agentSessionId, 'native-telegram-reply', 'Exact finite Telegram answer'); f.services.publication!.refresh()
  await until(() => expect([...wire.messages.values()].some(message => message.chat.id === 400 && message.text?.includes('Exact finite Telegram answer'))).toBe(true))
  wire.message('Exhausted private input', { chatId: 400, chatType: 'private', mention: false })
  await until(async () => expect((await f.records()).find(row => row.body === 'Exhausted private input')).toMatchObject({ state: 'refused', code: 'MOTE_CHAT_QUOTA_EXHAUSTED' }))
  expect((await f.sdk.call('space.mote.chat.audience', { target: f.target })).people).toMatchObject([{ creator: false, total: 1, used: 1, remaining: 0 }])
  expect(f.start).toHaveBeenCalledOnce(); expect(f.nativeInputs()).toHaveLength(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)
