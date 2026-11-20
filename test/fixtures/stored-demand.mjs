import { randomUUID } from 'node:crypto'

/** Seed an already-issued historical identity in an isolated test store. */
export function seedStoredDemand(store, { id, ...content }, options = {}) {
  const operationId = options.operationId ?? randomUUID()
  return store.mutate('create', snapshot => {
    if (snapshot.demands.some(item => item.id === id) || snapshot.retiredGoals?.some(item => item.id === id))
      throw new Error('This original fixture identity cannot be issued twice.')
    const demand = store.createRecord(content, options, id, operationId)
    snapshot.demands.push(demand)
    return demand
  }, undefined, operationId)
}
