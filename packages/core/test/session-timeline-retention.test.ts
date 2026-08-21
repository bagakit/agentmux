import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { applyAgentTimelineMutation, normalizeAgentTimeline } from '../src/session-timeline.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem } from '../src/types.js'

const roots: string[] = []
const agentSessionId = 'retention-session'
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function item(id: string, kind: AgentTimelineItem['kind'] = 'tool_call', content = id): AgentTimelineItem {
  return { id, agentSessionId, kind, source: kind === 'user_message' ? 'user' : 'native-hook',
    status: 'complete', createdAt: 1, updatedAt: 1, title: id, content }
}
function items(prefix: string, count: number, kind: AgentTimelineItem['kind'] = 'tool_call'): AgentTimelineItem[] {
  return Array.from({ length: count }, (_, index) => item(`${prefix}-${index}`, kind))
}
async function fileStore() {
  const root = await mkdtemp('/private/tmp/agentmux-timeline-retention-')
  roots.push(root)
  const path = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex-safe', hostId: 'local',
    workspacePath: root, run: { runId: 'run-1' }, retiredRuns: [], hookBindingId: 'hook-1',
    hookToken: 'token-1', outputCursorBytes: 0, createdAt: 1, updatedAt: 1
  }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId, item: item('seed') })
  const names = await readdir(join(root, 'agent-timelines'))
  expect(names).toHaveLength(1)
  return { store, path, timelinePath: join(root, 'agent-timelines', names[0]!) }
}
function snapshot(history: AgentTimelineItem[]) {
  return { version: 3, agentSessionId, revision: 1, items: history }
}

describe('independent input and activity retention in the same timeline', () => {
  it.each(['append', 'upsert'] as const)('%s retains both windows in original order under either flood', (type) => {
    const mail = item('agent-mail', 'user_message', 'Please review this change')
    let history = [mail]
    const tools = items('tool', 201)
    for (const entry of tools) history = applyAgentTimelineMutation(history, { type, agentSessionId, item: entry })
    expect(history).toEqual([mail, ...tools.slice(1)])

    const inputs = items('sent', 201, 'user_message')
    for (const entry of inputs) history = applyAgentTimelineMutation(history, { type, agentSessionId, item: entry })
    expect(history).toEqual([...tools.slice(1), ...inputs.slice(1)])
    const lastTool = item('last-tool')
    history = applyAgentTimelineMutation(history, { type, agentSessionId, item: lastTool })
    expect(history).toEqual([...tools.slice(2), ...inputs.slice(1), lastTool])
  })

  it('reapplies windows when an existing upsert changes kind without moving the item', () => {
    const inputs = items('sent', 200, 'user_message')
    const activity = items('tool', 200)
    const converted = { ...activity[199]!, kind: 'user_message' as const, updatedAt: 2 }
    const history = applyAgentTimelineMutation([...inputs, ...activity], {
      type: 'upsert', agentSessionId, item: converted
    })
    expect(history).toEqual([...inputs.slice(1), ...activity.slice(0, 199), converted])
    expect(normalizeAgentTimeline(agentSessionId, history)).toEqual(history)
  })

  it('normalizes all 400 mixed records but rejects either oversized window and total overflow', () => {
    const mixed = [...items('sent', 200, 'user_message'), ...items('tool', 200)]
    expect(normalizeAgentTimeline(agentSessionId, mixed)).toEqual(mixed)
    expect(() => normalizeAgentTimeline(agentSessionId, items('sent', 201, 'user_message')))
      .toThrow(expect.objectContaining({ code: 'AGENT_TIMELINE_LIMIT' }))
    expect(() => normalizeAgentTimeline(agentSessionId, items('tool', 201)))
      .toThrow(expect.objectContaining({ code: 'AGENT_TIMELINE_LIMIT' }))
    expect(() => normalizeAgentTimeline(agentSessionId, [...mixed, item('overflow')]))
      .toThrow(expect.objectContaining({ code: 'AGENT_TIMELINE_LIMIT' }))
  })

  it('reopens real FileStore with one mail plus 200 tools and preserves activities through an input flood', async () => {
    const { store, path } = await fileStore()
    const mail = item('agent-mail', 'user_message', 'A durable incoming request')
    await store.applyTimelineMutation({ type: 'append', agentSessionId, item: mail })
    const tools = items('tool', 200)
    for (const entry of tools) await store.applyTimelineMutation({ type: 'append', agentSessionId, item: entry })
    const restarted = new AgentMuxFileAgentSessionStore(path)
    expect((await restarted.loadTimeline(agentSessionId)).items).toEqual([mail, ...tools])
    const inputs = items('sent', 200, 'user_message')
    for (const entry of inputs) await restarted.applyTimelineMutation({ type: 'append', agentSessionId, item: entry })
    expect((await new AgentMuxFileAgentSessionStore(path).loadTimeline(agentSessionId)).items)
      .toEqual([...tools, ...inputs])
  }, 30_000)

  it('reopens and compacts a mixed snapshot above 4 MiB while below the 8 MiB total bound', async () => {
    const { path, timelinePath } = await fileStore()
    const history = [...items('sent', 30, 'user_message'), ...items('tool', 30)]
      .map((entry) => ({ ...entry, content: 'x'.repeat(100 * 1024) }))
    const document = JSON.stringify(snapshot(history)) + '\n'
    expect(Buffer.byteLength(document)).toBeGreaterThan(4 * 1024 * 1024)
    expect(Buffer.byteLength(document)).toBeLessThan(8 * 1024 * 1024)
    await writeFile(timelinePath, document)
    const reopened = new AgentMuxFileAgentSessionStore(path)
    expect((await reopened.loadTimeline(agentSessionId)).items).toEqual(history)
    const next = item('after-restart', 'user_message')
    await reopened.applyTimelineMutation({ type: 'append', agentSessionId, item: next })
    expect((await readFile(timelinePath, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect((await new AgentMuxFileAgentSessionStore(path).loadTimeline(agentSessionId)).items)
      .toEqual([...history, next])
  }, 30_000)

  it('rejects a file above 8 MiB before replay even when its snapshot shape is valid', async () => {
    const { path, timelinePath } = await fileStore()
    await writeFile(timelinePath, JSON.stringify({ ...snapshot([item('valid')]), padding: 'x'.repeat(8 * 1024 * 1024) }) + '\n')
    await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline(agentSessionId))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
  })

  it('rejects compacted snapshots above 8 MiB without replacing the prior durable history', async () => {
    const { path, timelinePath } = await fileStore()
    const history = items('tool', 81).map((entry) => ({ ...entry, content: 'x'.repeat(100 * 1024) }))
    const next = item('overflow', 'user_message', 'x'.repeat(100 * 1024))
    const document = JSON.stringify(snapshot(history)) + '\n'
    expect(Buffer.byteLength(document)).toBeLessThan(8 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(snapshot([...history, next])))).toBeGreaterThan(8 * 1024 * 1024)
    await writeFile(timelinePath, document)
    const reopened = new AgentMuxFileAgentSessionStore(path)
    await expect(reopened.applyTimelineMutation({ type: 'append', agentSessionId, item: next }))
      .rejects.toMatchObject({ code: 'AGENT_TIMELINE_STORE_LIMIT' })
    expect(await readFile(timelinePath, 'utf8')).toBe(document)
    expect((await new AgentMuxFileAgentSessionStore(path).loadTimeline(agentSessionId)).items).toEqual(history)
  }, 30_000)

  it('keeps the independent 128 KiB mutation bound', () => {
    expect(() => applyAgentTimelineMutation([], {
      type: 'append', agentSessionId, item: item('large', 'user_message', 'x'.repeat(128 * 1024))
    })).toThrow(expect.objectContaining({ code: 'AGENT_TIMELINE_TOO_LARGE' }))
  })
})
