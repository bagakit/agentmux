export interface OwnerDisposalStep {
  owner: string
  dispose(): void | Promise<void>
}

/** Attempt each owner independently; retain its identity and original failure for local diagnostics. */
export async function runOwnerDisposals(
  steps: ReadonlyArray<OwnerDisposalStep>,
  message: string
): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step.dispose()
    } catch (error) {
      failures.push(new Error(`Owner ${step.owner} disposal failed`, { cause: error }))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message)
}
