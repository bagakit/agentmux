import { defineConfig } from 'vitest/config'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'handoff-without-binding': ['apps/host/src/mote-group.ts',
    'membership = await store.memberForThread(input.groupId, actor.hostId, actor.agentSessionId)',
    'membership = await store.member(input.groupId, input.memberMoteId)'],
  'private-report-without-outbox': ['apps/host/src/mote-group-store.ts',
    "if (reportSender && this.kind === 'direct') db.prepare(", 'if (false && reportSender) db.prepare('],
  'schedule-reuses-rejoined-member': ['apps/host/src/mote-group-store.ts',
    "record.member.state !== 'active' || scheduledGenerations.get(delivery.moteId) !== memberGeneration",
    "record.member.state !== 'active'"],
  'pause-claimed-mote-work-on-reopen': ['apps/host/src/continuous-progress-loop-manager.ts',
    "loop.pendingCompletion && loop.status === 'active' && !loop.moteWork", "loop.pendingCompletion && loop.status === 'active'"],
  'conflate-mote-space-and-topic': ['apps/host/src/mote-group.ts',
    'sameMotePreferencesTarget(snapshot.target, target)', 'snapshot.identity.moteId === target.spaceId'],
  'ignore-private-priority': ['packages/core/src/client.ts',
    "else if (context.backgroundOrder === 'priority') ordered.push(context)", "else if (false) ordered.push(context)"],
  'steer-with-private-priority': ['packages/core/src/client.ts',
    "saved.intent.source.kind === 'prompt' && saved.intent.source.backgroundPriority ? { nativeIdleOnly: true }", "false ? { nativeIdleOnly: true }"],
  'image-without-thread-scope': ['apps/host/src/mote-direct.ts',
    'const { messages } = await inspectPrivate(image.threadId, mote, { messageId: image.messageId }, context)',
    'const messages = [await owner.store.messageById(image.threadId, image.messageId)]'],
  'direct-schedule-wrong-peer': ['packages/core/src/mote/direct.ts',
    'peer: target(input.peer)', 'peer: target(input.mote)'],
  'direct-schedule-reuses-operation': ['apps/host/src/continuous-progress-loop-manager.ts',
    'const operationId = `scheduled/${loopId}/${occurrenceAt}`', 'const operationId = `scheduled/${loopId}/first`'],
  'direct-pair-order': ['apps/host/src/mote-direct.ts',
    'const members = [mote, peer].sort((left, right) => left.spaceId < right.spaceId ? -1 : 1)',
    'const members = [mote, peer]'],
  'main-authority': ['apps/host/src/mote-group.ts',
    'if (original.current?.hostId !== actor.hostId || original.current.sessionId !== actor.agentSessionId)',
    'if (false)'],
  'duplicate-send': ['apps/host/src/mote-group.ts', 'if (!fresh) return { message: await readMessage(message) }', 'if (false) return { message: await readMessage(message) }'],
  'drop-quote': ['apps/host/src/mote-group.ts', 'key.submissionId, quoted, message)', 'key.submissionId, undefined, message)'],
  'reply-admission': ['apps/host/src/mote-group.ts',
    'if (!accepted(receipt) || fact?.userContent', 'if (fact?.userContent'],
  'reply-readback': ['apps/host/src/mote-group.ts',
    'if (prior) {\n      const { author } = prior.message', 'if (false && prior) {\n      const { author } = prior.message'],
  'membership-generation': ['apps/host/src/mote-group.ts',
    "requireActive(source.membership, source.record.memberGeneration ?? 'original')",
    "requireActive(source.membership)"],
  'topic-confinement': ['apps/host/src/mote-group-files.ts', 'readDirectory(physical, input.path, true)', 'readDirectory(physical, input.path)']
} as const
const variant = process.env.AMUX_MOTE_GROUP_MUTANT as keyof typeof variants | undefined
if (variant && !Object.hasOwn(variants, variant)) throw Error('Unknown Group mutation ' + variant)
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], {
  name: 'original-mote-group-mutation', enforce: 'pre', load(id) {
    if (!variant) return
    const [path, before, after] = variants[variant]
    if (id.split('?')[0] !== resolve(root, path)) return
    const body = readFileSync(id, 'utf8')
    if (body.split(before).length !== 2) throw Error('Original Group mutation anchor changed')
    return body.replace(before, after)
  }
}], test: { ...source.test, include: ['apps/host/test/mote-group.test.ts'], passWithNoTests: false,
  maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } })
