import type { SessionSnapshot } from '../../src/shared/contracts'
import { moteAgent, moteConfig, moteTopics } from './mote-workface'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { readSpatialAppearance } from '../../src/renderer/src/lib/mobile-presentation'
import { topicSpaceIconTarget } from '../../src/renderer/src/lib/space-object-appearance'
import { DEFAULT_MOTE_FACE } from '../../src/shared/mote-avatars'
import { useAppStore } from '../../src/renderer/src/store'

export function currentMote(now = Date.now()): Extract<SessionSnapshot, { kind: 'agent' }> {
  const original = moteAgent('expression-original', moteTopics[1]!.id)
  return { ...original, status: { state: 'working', source: 'native-hook', observedAt: now },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now },
    currentActivity: { state: 'active', nativeSessionId: 'native-original', nativeTurnId: 'turn-original',
      sourceId: 'original-channel', sequence: 1, source: 'native-hook', run: original.control.run,
      hookReceiptId: 'original-hook-receipt', observedAt: now } }
}
export function moteAppearanceSource(session = currentMote()) {
  const topic = moteTopics[1]!, workspace = moteConfig.workspaces[0]!, target = topicSpaceIconTarget(workspace, topic)
  const state = { ...useAppStore.getState(), config: moteConfig, sessions: [session], tabs: {}, layouts: {},
    spaceZoneBindings: {}, spatialRequests: {}, timelines: {}, spaceObjectIcons: { [target.key]: DEFAULT_MOTE_FACE } }
  const catalog = spatialCatalog(state, [topic])
  return { state, topic, workspace, target, catalog,
    read: (selected = catalog) => readSpatialAppearance(state, selected, undefined, [topic], async () => { throw new Error('No image read is required for the saved original face') }) }
}
