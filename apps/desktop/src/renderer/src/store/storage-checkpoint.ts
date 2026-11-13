/**
 * One checkpoint step per storage owner. The spatial graph, the Desktop user document and the
 * Main flush each own their own durability, so a refused step never skips the others: every step
 * runs, and the first failure is the result.
 */
export async function runIndependentCheckpoints(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  let failure: { error: unknown } | null = null
  for (const step of steps) {
    try { await step() } catch (error) { failure ??= { error } }
  }
  if (failure) throw failure.error
}
