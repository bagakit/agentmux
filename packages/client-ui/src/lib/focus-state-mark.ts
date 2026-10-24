/** Presentation only: these shapes never grant input or classify Runtime health. */
export type FocusStateMarkKind = 'error' | 'attention' | 'working' | 'results' | 'unknown' | 'interrupted' | 'recovery' | 'idle'
export function focusStateMarkKind(context: { bucket: string; state: string; activitySemantic?: string | undefined; runUnobserved?: boolean | undefined; processState?: string | null | undefined }): FocusStateMarkKind {
  const unknown = context.bucket === 'idle' && (context.activitySemantic === 'unknown' || context.activitySemantic === 'unsupported' || context.activitySemantic === undefined && context.state === 'running')
  return context.bucket === 'attention' ? context.state === 'error' ? 'error' : 'attention'
    : context.bucket === 'working' ? 'working' : context.bucket === 'results' ? 'results'
      : context.runUnobserved ? 'unknown' : context.processState === 'interrupted' ? 'interrupted'
        : unknown ? 'unknown' : context.processState !== 'running' ? 'recovery' : 'idle'
}
