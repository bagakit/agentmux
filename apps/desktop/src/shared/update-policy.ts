export type UpdateIdentity = { shell: string; ctxmux: string }
export type UpdateRoute = 'renderer' | 'application' | 'runtime-review'

/** A missing identity is unknown, never evidence that a hot update is compatible. */
export function updateRoute(current: UpdateIdentity | null | undefined, candidate: UpdateIdentity | null | undefined): UpdateRoute {
  if (typeof current?.ctxmux !== 'string' || !current.ctxmux || current.ctxmux !== candidate?.ctxmux) return 'runtime-review'
  return typeof current.shell === 'string' && current.shell && current.shell === candidate.shell ? 'renderer' : 'application'
}
