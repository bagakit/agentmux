import { createHash } from 'node:crypto'
export const takeoverMutations = {
  'local-c-never-continues': { path: 'apps/host/src/spatial-agent-control.ts', before: 'await createOriginalLocalTakeover(previous, request)', after: 'void previous', test: 'explicit continuation advances a C-only' },
  'local-c-context-not-frozen': { path: 'apps/host/src/spatial-agent-control.ts', before: 'if (takeover) await prepareContext()', after: 'if (false) await prepareContext()', test: 'real Club freezes its original Profile' },
  'local-c-source-note-unchecked': { path: 'packages/core/src/client.ts', before: 'input.sourceAgentMuxNote !== original.takeoverSourceAgentMuxNote', after: 'false', test: 'trusted original C rejects every changed context' },
  'local-c-optional-unchecked': { path: 'packages/core/src/client.ts', before: '!isDeepStrictEqual(input.optionalContext, original.takeoverOptionalContext)', after: 'false', test: 'trusted original C rejects every changed context' },
  'local-c-caller-unchecked': { path: 'packages/core/src/client.ts', before: 'return await this.createConfiguredHostAgentWithDelivery({ ...input, takeover: original.takeover }, caller)', after: 'return await this.createConfiguredHostAgentWithDelivery({ ...input, takeover: original.takeover })', test: 'trusted spatial composition preserves real caller' },
  'healthy-c-reenters-creator': { path: 'apps/host/src/spatial-agent-control.ts', before: "if (observed.agent || observed.outcome === 'retired' || previous.execution.hostId", after: "if (observed.outcome === 'retired' || previous.execution.hostId", test: 'already confirmed original Agent remains a read' },
  'display-hides-club': { path: 'packages/core/src/agent-takeover.ts', before: "const spaces = new Set(address.zoneId ? graph.bindings.filter(value => value.zoneId === address.zoneId).map(value => value.spaceId) : address.spaceId ? [address.spaceId] : [])", after: "const spaces = new Set(address.spaceId ? [address.spaceId] : [])", test: 'category display selector' },
  'skip-final-policy': { path: 'apps/host/src/spatial-agent-control.ts', before: 'if (takeoverRequiresPromotion(admission.graph, admission.record.address, takeover.preparation.source)) await assertPromotionEnabled(options.configurationPath)', after: 'if (false) await assertPromotionEnabled(options.configurationPath)', test: 'final admission rechecks exact policy' },
  'unqualified-source': { path: 'packages/core/src/agent-takeover.ts', before: "const zones = new Set(graph.bindings.filter(value => value.spaceId === reference.spaceId).map(value => value.zoneId))", after: "return takeoverOrganization(graph.spaces.find(value => value.spaceId === reference.spaceId), reference.runtimeId); const zones = new Set(graph.bindings.filter(value => value.spaceId === reference.spaceId).map(value => value.zoneId))", test: 'unrelated real Project' },
  'public-raw-fact': { path: 'packages/core/src/client.ts', before: "if ('takeover' in input) throw new AgentMuxError('Takeover provenance is read only from its original spatial admission.', 'INVALID_CONTROL_REQUEST')", after: 'if (false) throw new Error()', test: 'public execution and direct/Hosted' },
  'incoming-uses-old-sid': { path: 'packages/core/src/spatial-state.ts', before: "[['incoming', value.execution.runtimeId ?? '', value.agentSessionId]]", after: "[['incoming', value.execution.runtimeId ?? '', value.takeover.source.agentSessionId ?? '']]", test: 'actual CLI opens' },
  'cross-core-is-local': { path: 'packages/core/src/public-rpc-service.ts', before: 'const sameCore = (request.content.agentTarget?.runtimeId ?? current.runtimeId) === identity.runtimeId', after: 'const sameCore = true', test: 'separate execution Core' },
  'source-runtime-ignored': { path: 'packages/core/src/public-rpc-service.ts', before: 'if (origin.expectedRuntimeId !== undefined && origin.expectedRuntimeId !== identity.runtimeId)', after: 'if (false)', test: 'exact source Runtime pin' },
  'restore-drops-provenance': { path: 'packages/core/src/agent-session-store.ts', before: '...(creation.takeover === undefined ? {} : { takeover: parseAgentTakeoverProvenance(creation.takeover) }),', after: '', test: 'independent reader processes' }
}
export function takeoverSource(relativePath, original, mutant) {
  const selected = mutant && takeoverMutations[mutant]
  if (mutant && !selected) throw new Error('Unknown Takeover production mutation.')
  let loaded = original
  if (selected?.path === relativePath) {
    const count = original.split(selected.before).length - 1
    // The same public rejection guards both original public creators; mutate the first exact owner.
    if (count !== (mutant === 'public-raw-fact' ? 3 : 1)) throw new Error('Takeover mutation did not match its exact original owner: ' + mutant)
    loaded = original.replace(selected.before, selected.after)
  }
  const sha = value => createHash('sha256').update(value).digest('hex')
  return { loaded, receipt: { path: relativePath, mutation: mutant ?? null, originalSHA256: sha(original), loadedSHA256: sha(loaded), changed: loaded !== original } }
}
