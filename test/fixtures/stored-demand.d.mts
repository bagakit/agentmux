import type { CreateDemandInput, DemandCreateOptions, DemandReceipt } from '../../packages/demand/src/demand-types.js'
import type { DemandStore } from '../../packages/demand/src/demand-store.js'

export function seedStoredDemand(store: DemandStore, input: CreateDemandInput & { id: string }, options?: DemandCreateOptions): Promise<DemandReceipt>
