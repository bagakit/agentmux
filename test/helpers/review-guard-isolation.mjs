/** Fixture Git must neither read inherited objects/templates nor write outside its own repository. */
export function isolatedGitEnvironment(source = process.env) {
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

/** Release every owned fixture even when an earlier release fails. */
export async function closeReviewFixtures(cleanup) {
  const errors = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() }
    catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Review fixture cleanup failed')
}
