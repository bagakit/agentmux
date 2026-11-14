/**
 * One checkpoint step per storage owner. The spatial graph, the Desktop user document and the
 * Main flush each own their own durability, so a refused step never skips the others: every step
 * runs, and the first failure is the result.
 */
export async function runIndependentCheckpoints(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  // Each owner starts even if another never replies. Preserve deterministic failure ordering.
  const results = await Promise.allSettled(steps.map(step => Promise.resolve().then(step)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
