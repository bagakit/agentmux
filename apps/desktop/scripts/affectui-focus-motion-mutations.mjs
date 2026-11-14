const signal = 'apps/desktop/src/renderer/src/components/CollaborationDispatchSignal.tsx'
const graph = 'apps/desktop/src/renderer/src/components/AgentCollaborationGraph.tsx'
const reading = 'apps/desktop/src/renderer/src/lib/use-collaboration-reading.ts'
export const focusMotionMutations = {
  owningConfig: 'apps/desktop/test/vitest.collaboration-canvas.config.mts',
  tests: ['apps/desktop/test/collaboration-dispatch-motion.test.tsx', 'apps/desktop/test/collaboration-motion-cascade.test.tsx'],
  sources: [signal, graph, reading, 'apps/desktop/src/renderer/src/styles/collaboration.css', 'apps/desktop/src/renderer/src/lib/use-collaboration-motion.ts', 'apps/desktop/scripts/affectui-focus-motion-mutations.mjs'],
  mutations: [
    { label: 'expired-transfer-does-not-replay', file: signal, before: 'if (delay <= -COLLABORATION_TRANSFER_MS) return null', after: 'if (false) return null' },
    { label: 'original-phase-survives-renders', file: signal, before: 'useMemo(() => Math.min(0, startedAt - Date.now()), [pulseId, startedAt])', after: 'Math.min(0, startedAt - Date.now())' },
    { label: 'supervision-is-not-a-new-message', file: signal, before: "if (kind === 'supervision') return <path", after: 'if (false) return <path' },
    { label: 'bounded-screen-tail', file: signal, before: 'Math.min(.14, 72 / screenLength)', after: '.14' },
    { label: 'actual-clipped-route-consumer', file: graph, before: 'startedAt={record.startedAt} path={path} length={routeLength}', after: 'startedAt={record.startedAt} path="M 0 0 L 1 1" length={routeLength}' },
    { label: 'effective-motion-controls-the-transfer', file: graph, before: "{record.active && motion && kind !== 'creation' ? <CollaborationDispatchSignal", after: "{record.active && kind !== 'creation' ? <CollaborationDispatchSignal" },
    { label: 'short-captions-leave-the-flow-channel', file: graph, before: 'const detachedCaption = routeLength * zoom < 160', after: 'const detachedCaption = false' },
    { label: 'duplicate-events-do-not-replay', file: reading, before: 'if (event.sequence <= (current.through.get(hostId) ?? 0)) return', after: 'if (false) return' },
    { label: 'historical-events-do-not-animate', file: reading, before: "event.type !== 'agent-message-changed' || !event.live ||", after: "event.type !== 'agent-message-changed' ||" }
  ]
}
