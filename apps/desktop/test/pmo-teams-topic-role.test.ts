import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { DEFAULT_PMO_TEAMS_TOPIC_WIKI, DEFAULT_TOPIC_WIKI, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

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
  it('injects coordination identity and confirm-before-execution boundary only for launcher:leader', async () => {
    const topics = new ScratchTopics()
    const prepared = await topics.prepareAgent(await workspace(), 'launcher:leader', { providerId: 'codex', sessionId: 'leader-1' })

    expect(prepared.snapshot.wiki?.content).toBe(DEFAULT_PMO_TEAMS_TOPIC_WIKI)
    expect(prepared.prompt).toContain('You are a coordinator in PMO teams')
    expect(prepared.prompt).toContain('Implement personally only when the user explicitly asks')
    expect(prepared.prompt).toContain('Do not create an empty Demand before the proposed requirement is understood and confirmed')
  })

  it('keeps ordinary Topics on the generic role and Wiki', async () => {
    const topics = new ScratchTopics()
    const prepared = await topics.prepareAgent(await workspace(), 'view:ordinary', { providerId: 'codex', sessionId: 'ordinary-1' })

    expect(prepared.snapshot.wiki?.content).toBe(DEFAULT_TOPIC_WIKI)
    expect(prepared.prompt).not.toContain('You are a coordinator in PMO teams')
    expect(prepared.prompt).not.toContain('Do not create an empty Demand before the proposed requirement is understood and confirmed')
  })
})
