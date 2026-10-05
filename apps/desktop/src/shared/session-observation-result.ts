/** Session output reads carry typed failures as data through Electron's Error boundary. */
export type SessionObservationResult<T> = { ok: true; result: T } | { ok: false; error: {
  code: string; message: string; detail?: string
} }

export async function sessionObservationResult<T>(observe: () => Promise<T>): Promise<SessionObservationResult<T>> {
  try { return { ok: true, result: await observe() } }
  catch (error) {
    const source = error instanceof Error ? error as Error & { code?: unknown; detail?: unknown } : null
    return { ok: false, error: {
      code: typeof source?.code === 'string' ? source.code : 'SESSION_OBSERVATION_UNCONFIRMED',
      message: source?.message ?? String(error),
      ...(typeof source?.detail === 'string' ? { detail: source.detail } : {})
    } }
  }
}

export function unwrapSessionObservationResult<T>(result: SessionObservationResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.result
}
