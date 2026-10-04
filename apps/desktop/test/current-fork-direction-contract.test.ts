import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { currentForkRequest, reviewCurrentFork } from '../src/renderer/src/lib/agent-current-fork'
import { parseSpaceControlRequest } from '../../../packages/core/src/space-control-parser'
const origin = { workspaceId: 'display-workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region', sessionId: 'a123456789012345' }
const handle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native', transcriptPath: _hygiene_fixturePath("private/current.jsonl") }
const session = { id: origin.sessionId, kind: 'agent', hostId: 'local', providerId: 'codex', executorId: 'private', workspacePath: _hygiene_fixturePath("private"), control: { kind: 'agent', hostId: 'local', agentSessionId: origin.sessionId, run: { runId: 'original-run' } }, nativeHandle: handle, capabilities: { providerFork: { current: true } } } as unknown as Parameters<typeof reviewCurrentFork>[0]
const location = { spaceId: null, zoneId: 'original-zone', workspaceId: 'resource-workspace', displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId: origin.tabId, regionId: origin.regionId }
const catalog = { spaces: [], zones: [], bindings: [], tabs: [], regions: [{ regionId: origin.regionId, tabId: origin.tabId, kind: 'agent', agentSessionId: origin.sessionId, runId: 'original-run', execution: { hostId: 'local', cwd: _hygiene_fixturePath("private") } }], locations: [location] } as unknown as Parameters<typeof currentForkRequest>[2]
it.each(['left', 'right', 'up', 'down'] as const)('actual current fork %s request is accepted by public Space parser', direction => {
  const request = currentForkRequest(reviewCurrentFork(session, origin, 'fork-operation'), session, catalog, direction, true)
  const accepted = parseSpaceControlRequest(request)
  expect(accepted).toMatchObject({ operation: 'agent.open', content: { kind: 'fork-agent', source: { agentSessionId: origin.sessionId, expectedRun: { runId: 'original-run' }, expectedNativeHandle: handle } }, destination: { zoneId: location.zoneId, tabId: origin.tabId, regionId: origin.regionId, split: direction } })
})
