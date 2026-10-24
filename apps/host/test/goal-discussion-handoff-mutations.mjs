import { createHash } from 'node:crypto'

export const handoffMutations = {
  'public-forged-binding': ['packages/core/src/spatial-state.ts',
    "if (key.startsWith('owned:') && (!current || !Object.hasOwn(current.graph.resources, key) || !isDeepStrictEqual(value, current.graph.resources[key])))",
    'if (false)'],
  'source-before-durable-ack': ['apps/desktop/src/renderer/src/lib/goal-discussion-handoff.ts',
    "if (receipt.diskDurability !== 'confirmed' || receipt.key !== 'owned:goal-discussion:' + goalId)", 'if (false)'],
  'changed-region-recipient': ['apps/host/src/goal-discussion-bindings.ts',
    'region.agentSessionId !== binding.recipient.agentSessionId', 'false'],
  'pending-launcher-projection': ['apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
    "if (surface.phase === 'launching' && !session && original?.tabId === tab.id && original.kind === 'launcher')", 'if (false)'],
  'metadata-blocks-native': ['apps/desktop/src/main/goal-discussion-handoff.ts',
    "if (!state) return { metadataIssue: 'The original Launcher spatial document is unavailable; its Goal binding remains unconfirmed.' }",
    "if (!state) throw new AgentMuxError('Private metadata failure must not block the native creator.', 'GOAL_DISCUSSION_UNCONFIRMED')"]
}
const observed = new Set(['packages/core/src/client.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/spatial-state.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/rpc-native-codec.ts', 'apps/host/src/goal-discussion-bindings.ts', 'apps/host/src/goal-discussion-launcher.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/goal-discussions.ts',
  'apps/desktop/src/main/goal-discussion-handoff.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/lib/goal-discussion-handoff.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/mobile/src/goals/MobileGoalsSurface.tsx', 'apps/mobile/src/navigation/MobileZoneWorkface.tsx'])
export function instrumentHandoffSource(source, path, surface) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.GOAL_HANDOFF_MUTANT
  if (mutant && !Object.hasOwn(handoffMutations, mutant)) throw Error('Unknown Goal handoff mutation')
  if (mutant && handoffMutations[mutant][0] === path) {
    const [, before, after] = handoffMutations[mutant]
    if (source.split(before).length !== 2) throw Error('A handoff mutation requires one exact loaded owner')
    source = source.replace(before, after)
  }
  const report = process.env.GOAL_HANDOFF_LOADED
  if (report) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, surface, originalSHA256: hash(original), loadedSHA256: hash(source),
      ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __handoffEvaluated } from 'node:fs'; __handoffEvaluated(" + JSON.stringify(report) +
      ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
