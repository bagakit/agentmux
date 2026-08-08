export type UpdateIdentity = { shell: string; ctxmux: string }
export type UpdateRoute = 'renderer' | 'application' | 'runtime-review'

/** A missing identity is unknown, never evidence that a hot update is compatible. */
export function updateRoute(current: UpdateIdentity, candidate: UpdateIdentity): UpdateRoute {
  if (!current.ctxmux || !candidate.ctxmux || current.ctxmux !== candidate.ctxmux) return 'runtime-review'
  return current.shell && current.shell === candidate.shell ? 'renderer' : 'application'
}
