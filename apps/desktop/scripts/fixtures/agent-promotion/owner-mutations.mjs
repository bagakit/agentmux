import { createHash } from 'node:crypto'
export const acceptedPromotionMutations = [
  { name: 'personality-sync', mode: 'personality', path: 'apps/host/src/agent-promotion.ts', before: 'await this.ports.scratch.prepareMotePromotion(record.workspace, record.topicId)', after: '/* skip original personality durability owner */' },
  { name: 'main-promise', mode: 'main', path: 'apps/host/src/agent-promotion.ts', before: 'await publish(path, content)', after: '/* lose the original accepted Main promise */' },
  { name: 'main-presence', mode: 'main', path: 'apps/host/src/agent-promotion.ts', before: 'presence: { ...DEFAULT_MOTE_PRESENCE, enabled: false }', after: 'presence: { ...DEFAULT_MOTE_PRESENCE, enabled: true }' },
  { name: 'completion-sync', mode: 'ack', path: 'apps/host/src/agent-promotion.ts', before: 'await sync(path); await sync(dirname(path))\n    return true', after: '/* readable marker is not its durability ACK */\n    return true' },
  { name: 'completed-history', mode: 'history', path: 'apps/host/src/agent-promotion.ts', before: "if (await this.completed(record)) return 'complete'", after: "if (false) return 'complete'" },
  { name: 'broad-membership', mode: 'main', path: 'packages/core/src/agent-promotion.ts', before: '  const next = structuredClone(graph)\n  next.tabs.push', after: '  const next = structuredClone(graph)\n  next.bindings.push({spaceId:input.spaceId,zoneId:sourceTab.zoneId!})\n  next.tabs.push' }
]
export function acceptedPromotionSource(path, original, mutation) {
  const selected = mutation && acceptedPromotionMutations.find(value => value.name === mutation)
  if (mutation && !selected) throw Error('Unknown accepted-promotion owner mutation.')
  let loaded = original
  if (selected?.path === path) {
    if (original.split(selected.before).length !== 2) throw Error('Accepted-promotion owner anchor must match exactly once: ' + mutation)
    loaded = original.replace(selected.before, selected.after)
  }
  const sha = value => createHash('sha256').update(value).digest('hex')
  return { loaded, trace: { path, mutation: mutation ?? null, originalSHA256: sha(original), loadedSHA256: sha(loaded) } }
}
