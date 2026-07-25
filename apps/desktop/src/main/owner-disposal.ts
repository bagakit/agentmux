export async function runOwnerDisposals(
  steps: ReadonlyArray<() => void | Promise<void>>,
  message: string
): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message)
}
