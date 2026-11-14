import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { MoteDialogueStore } from '@agentmux/core/mote-dialogue-store'
import { createMoteInputFixture, moteInputTestSource } from '../../../packages/core/test/helpers/mote-input-owner.js'
import { createHostContent } from '../src/content-owner.js'
import { createHostMoteDialogue, createHostMoteMainReader } from '../src/mote-dialogue.js'
import { serializeMoteQuickMode } from '../src/mote-model.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

/** Actual public Host, message journal, Dispatch and input owners; only Runtime/native I/O are private ports. */
async function fixture() {
  const f = await createMoteInputFixture(); cleanup.push(f.close)
  const content = createHostContent({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial })
  const main = createHostMoteMainReader({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial, files: content.files! })
  const dialogue = createHostMoteDialogue({ main, spatial: f.spatial, store: new MoteDialogueStore(join(f.root, 'wake-dialogue.sqlite')),
    clientForHost: () => f.client })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'wake.sock'), coreClients: f.coreClients, spatialState: f.spatial, moteDialogue: dialogue })
  await server.start(); cleanup.push(() => server.stop())
  const participant = async (agentSessionId: string) => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId, capability: f.capability } })
    cleanup.push(() => rpc.dispose()); return rpc
  }
  const primary = await participant('primary'), member = await participant('member')
  const target = { spaceId: moteInputTestSource.spaceId, zoneId: moteInputTestSource.zoneId,
    expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
  const notifications = Reflect.get(f.client, 'messageNotifications') as {
    observation?: { ready: Promise<void> }; drains: Map<string, { pending: Promise<void> }>
    changed(id: string): void; restore(): Promise<void>
  }
  const settled = async () => {
    await notifications.observation?.ready
    while (notifications.drains.size) await Promise.all([...notifications.drains.values()].map(entry => entry.pending))
  }
  const primaryWrites = () => f.writes.filter(write => write.key?.agentSessionId === 'primary')
  const idle = async () => { f.idle(); notifications.changed('primary'); await settled() }
  const assign = async (suffix: string) => {
    const before = await primary.call('space.mote.dialogue.read', { target })
    const sourceMessageId = 'work-' + suffix, threadId = 'thread-' + suffix
    await primary.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'member' }, text: 'Original scoped task ' + suffix,
      operationId: 'send-' + suffix, messageId: sourceMessageId, threadId })
    await primary.call('message.dispatch.open', { sourceMessageId })
    const linked = await primary.call('space.mote.dialogue.link', { target, operationId: 'link-' + suffix,
      expectedRoleRevision: before.main.roleRevision!, source: { kind: 'work', messageHostId: 'local', messageId: sourceMessageId } })
    const replyMessageId = 'reply-' + suffix
    await member.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'primary' }, text: 'Original result ' + suffix,
      operationId: 'reply-send-' + suffix, messageId: replyMessageId, replyTo: sourceMessageId, threadId })
    await settled()
    return { sourceMessageId, threadId, replyMessageId, linked }
  }
  const report = (work: Awaited<ReturnType<typeof assign>>) => member.call('message.dispatch.report', {
    sourceMessageId: work.sourceMessageId, replyMessageId: work.replyMessageId, kind: 'worker_done' })
  return { ...f, target, primary, member, notifications, settled, primaryWrites, idle, assign, report }
}

it('an ordinary Thread reply is observable before a report and its original native notice reaches the exact Main', async () => {
  const f = await fixture(), work = await f.assign('original')
  expect(f.primaryWrites()).toEqual([])
  const beforeReport = await f.primary.call('space.mote.dialogue.supervision.read', { target: f.target })
  expect(beforeReport.links).toEqual(work.linked.links)
  expect(beforeReport.observations[0]?.communication).toMatchObject({ replyMessageIds: [work.replyMessageId], events: [] })
  expect((await f.primary.call('message.read', { messageId: work.replyMessageId })).message?.notification).toEqual({ state: 'pending', automatic: 'idle-queue' })
  await f.report(work); await f.idle()
  expect(f.primaryWrites()).toHaveLength(1)
  const write = f.primaryWrites()[0]!
  expect(write.thread).toBe('primary-native')
  expect(write.key).toMatchObject({ kind: 'prompt', agentSessionId: 'primary', expectedRun: { runId: 'run-primary' } })
  expect(write.wire).toContain('msg-id="' + work.replyMessageId + '"')
  expect(write.wire).not.toContain('Original result original')
  if (write.key?.kind !== 'prompt') throw Error('The native notice must retain its original prompt key')
  const notice = await f.primary.call('message.notify.inspect', { hostId: 'local', operationId: write.key.submissionId })
  expect(notice.notification).toMatchObject({ state: 'submitted', key: write.key, messageIds: [work.replyMessageId] })
  expect(notice.input).toMatchObject({ agentSessionId: 'primary', run: write.key.expectedRun,
    admission: { inputKey: write.key, acknowledged: true, intent: { message: { a2aNotificationId: write.key.submissionId } } } })
  const page = await f.primary.call('space.mote.dialogue.supervision.read', { target: f.target })
  expect(page.observations[0]?.communication).toMatchObject({ replyMessageIds: [work.replyMessageId], events: [{ kind: 'worker_done', replyMessageId: work.replyMessageId }] })
  await f.report(work); await f.idle()
  expect(f.primaryWrites()).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('ordinary Thread replies share one original native reference batch without dropping either work source', async () => {
  const f = await fixture(), first = await f.assign('first'), second = await f.assign('second')
  await f.report(first); await f.report(second)
  expect(f.primaryWrites()).toEqual([])
  await f.idle()
  expect(f.primaryWrites()).toHaveLength(1)
  const write = f.primaryWrites()[0]!, key = write.key
  if (key?.kind !== 'prompt') throw Error('The native reference batch must retain its original prompt key')
  const notice = await f.primary.call('message.notify.inspect', { hostId: 'local', operationId: key.submissionId })
  expect(notice.notification).toMatchObject({ state: 'submitted', messageIds: [first.replyMessageId, second.replyMessageId], key })
  expect(write.wire).toContain('msg-id="' + first.replyMessageId + '"')
  expect(write.wire).toContain('msg-id="' + second.replyMessageId + '"')
  const page = await f.primary.call('space.mote.dialogue.supervision.read', { target: f.target })
  expect(new Set(page.links.flatMap(link => link.kind === 'work' ? [link.origin.messageId] : []))).toEqual(new Set([first.sourceMessageId, second.sourceMessageId]))
  expect(new Set(page.observations.flatMap(observation => observation.communication?.replyMessageIds ?? []))).toEqual(new Set([first.replyMessageId, second.replyMessageId]))
})

it('an ordinary Thread unknown native notice retains its original key across restore and a later Main selection', async () => {
  const f = await fixture(), work = await f.assign('unknown')
  await f.report(work); f.loseNotice(); await f.idle()
  expect(f.primaryWrites()).toHaveLength(1)
  const original = f.primaryWrites()[0]!, key = original.key
  if (key?.kind !== 'prompt') throw Error('The unknown notice must retain its original prompt key')
  const operationId = key.submissionId
  const before = await f.primary.call('message.notify.inspect', { hostId: 'local', operationId })
  expect(before.notification).toMatchObject({ state: 'unconfirmed', key, messageIds: [work.replyMessageId] })
  expect(before.input).toMatchObject({ agentSessionId: 'primary', run: key.expectedRun,
    admission: { inputKey: key, acknowledged: false, native: { outcome: 'unknown' } } })
  await writeFile(f.motePath, serializeMoteQuickMode('', { conversation: { hostId: 'local', sessionId: 'member',
    displayWorkspaceId: '__scratch__', groupId: 'group', tabId: 'tab-member', regionId: 'region-member' } }))
  const writes = f.writes.length
  await f.notifications.restore(); await f.idle()
  expect(await f.primary.call('message.notify.inspect', { hostId: 'local', operationId })).toEqual(before)
  expect(f.writes).toHaveLength(writes)
  expect(f.primaryWrites()).toEqual([original])
  expect(f.client.agentSession('primary').run).toEqual({ runId: 'run-primary' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
