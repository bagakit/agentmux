import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { DEFAULT_PMO_TEAMS_TOPIC_WIKI, DEFAULT_TOPIC_WIKI, MOTE_COORDINATION_ROLE, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<WorkspaceRecord> {
  const path = await mkdtemp(join(tmpdir(), 'agentmux-leader-role-'))
  roots.push(path)
  return { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path, kind: 'folder' }
}

describe('PMO teams topic role contract', () => {
  it('injects the shared coordination role and confirmation boundary for the leader', async () => {
    const topics = new ScratchTopics()
    const prepared = await topics.prepareAgent(await workspace(), 'launcher:leader', { providerId: 'codex', sessionId: 'leader-1' })

    expect(prepared.snapshot.wiki?.content).toBe(DEFAULT_PMO_TEAMS_TOPIC_WIKI)
    expect(prepared.prompt).toContain(MOTE_COORDINATION_ROLE)
    expect(prepared.prompt).toContain('Implement personally only when the user explicitly asks')
    expect(prepared.prompt).toContain('Do not create an empty Demand before the proposed requirement is understood and confirmed')
  })

  it('injects the same coordination role for a fresh non-leader Mote', async () => {
    const topics = new ScratchTopics()
    const project = await workspace()
    await topics.ensureMote(project, 'launcher:fresh-ideas')
    const prepared = await topics.prepareAgent(project, 'launcher:fresh-ideas', { providerId: 'codex', sessionId: 'fresh-1' })

    expect(prepared.snapshot.soul).toBeDefined()
    expect(prepared.snapshot.wiki?.content).toBe(DEFAULT_TOPIC_WIKI)
    expect(prepared.prompt).toContain(MOTE_COORDINATION_ROLE)
    expect(prepared.prompt).toContain('initial-instruction path')
    expect(prepared.prompt).toContain('bind the actual Executor and Session')
  })

  it('keeps ordinary Topics on the generic role and Wiki', async () => {
    const topics = new ScratchTopics()
    const prepared = await topics.prepareAgent(await workspace(), 'view:ordinary', { providerId: 'codex', sessionId: 'ordinary-1' })

    expect(prepared.snapshot.wiki?.content).toBe(DEFAULT_TOPIC_WIKI)
    expect(prepared.prompt).not.toContain(MOTE_COORDINATION_ROLE)
    expect(prepared.prompt).not.toContain('Do not create an empty Demand before the proposed requirement is understood and confirmed')
  })
})
