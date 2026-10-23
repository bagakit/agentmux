// A real serving process must resolve no Core, UI, or Run-runtime implementation.
export async function resolve(specifier, context, next) {
  if (
    /^(@agentmux\/(core|ctxmux|layout)|electron|react)(\/|$)/u.test(specifier) ||
    /\/apps\/(desktop|host)\//u.test(specifier)
  ) {
    throw new Error(`Independent Capsule runtime imported a forbidden owner: ${specifier}`)
  }
  return next(specifier, context)
}
