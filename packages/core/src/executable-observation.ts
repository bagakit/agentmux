import type { AgentCapabilitySnapshot } from './types.js'

/** Only the Provider's exact failed filesystem check permits an authorized Native attempt. */
export function unconfirmedExecutableObservation(capability: AgentCapabilitySnapshot | null, executable: string) {
  const observation = capability?.executableObservation
  return capability?.executable === executable && observation?.executable === executable && observation.availability === 'check-failed'
    ? observation : null
}
