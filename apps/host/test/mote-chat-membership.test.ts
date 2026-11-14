import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '@agentmux/core/spatial-layout'
import { createHostMoteMembership } from '../src/mote-membership.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('confirms only Host Sessions shown in the Mote’s own bound zones, and reports a missing spatial record as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mote-membership-')); roots.push(root)
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), placement = createHostMoteMembership(spatial)
  const member = (value: typeof target, agentSessionId: string, hostId = 'local') => placement(value, { hostId, agentSessionId })
  const target = { spaceId: 'mote', zoneId: 'home', expectedResource: { hostId: 'local', workspaceId: 'homes', workspacePath: root } }
  await expect(member(target, 'main')).rejects.toMatchObject({ code: 'MOTE_CHAT_MEMBERSHIP_UNCONFIRMED' })
  const zone = (zoneId: string) => ({ zoneId, workspaceId: 'homes', kind: 'directory' as const, hostId: 'local', directoryPath: join(root, zoneId), branch: null })
  const placed = [['main', 'home'], ['worker', 'project'], ['stranger', 'elsewhere'], ['loose', null]] as const
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'mote', kind: 'mote', name: 'Mote', hostId: 'local', directoryPath: root, projectId: null, topicId: 'mote-topic' },
      { spaceId: 'topic', kind: 'topic', name: 'Topic', hostId: 'local', directoryPath: root, projectId: 'project' }],
    zones: [zone('home'), zone('project'), zone('elsewhere')],
    bindings: [{ spaceId: 'mote', zoneId: 'home' }, { spaceId: 'mote', zoneId: 'project' }, { spaceId: 'topic', zoneId: 'elsewhere' }],
    tabs: [...placed.map(([id, zoneId]) => ({ tabId: `${id}-tab`, zoneId, workspaceId: 'homes', name: null, regionIds: [`${id}-region`] })),
      { tabId: 'shell-tab', zoneId: 'home', workspaceId: 'homes', name: null, regionIds: ['shell-region'] }],
    regions: [...placed.map(([id]) => ({ tabId: `${id}-tab`, regionId: `${id}-region`, kind: 'agent' as const, agentSessionId: id, runId: null, execution: { hostId: 'local', cwd: root } })),
      { tabId: 'shell-tab', regionId: 'shell-region', kind: 'terminal' as const, agentSessionId: 'shell', runId: null, execution: { hostId: 'local', cwd: root } }],
    layouts: { homes: createWorkspaceLayout('group', [...placed.map(([id]) => `${id}-tab`), 'shell-tab']) },
    tabLayouts: Object.fromEntries([...placed.map(([id]) => id), 'shell'].map(id => [`${id}-tab`, createWorkbenchViewLayout(`${id}-region`)])), resources: {}
  } })
  expect(await member(target, 'main')).toBe(true)
  expect(await member(target, 'worker')).toBe(true)
  // Another Runtime may use the same Session id; only the Host that runs the shown Region counts.
  expect(await member(target, 'main', 'remote')).toBe(false)
  for (const outside of ['stranger', 'loose', 'shell', 'absent']) expect(await member(target, outside)).toBe(false)
  expect(await member({ ...target, spaceId: 'topic' }, 'stranger')).toBe(false)
})
