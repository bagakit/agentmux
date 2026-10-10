import type { BrowserScriptRunReport } from './contracts'

/** Keep refusal facts as data across both IPC and contextBridge. */
export type BrowserRunResult = { ok: true; report: BrowserScriptRunReport } | { ok: false; error: {
  code: string; message: string; detail?: string
} }

export async function browserRunResult(run: () => Promise<BrowserScriptRunReport>): Promise<BrowserRunResult> {
  try { return { ok: true, report: await run() } }
  catch (error) {
    const source = error instanceof Error ? error as Error & { code?: unknown; detail?: unknown } : null
    return { ok: false, error: {
      code: typeof source?.code === 'string' ? source.code : 'CONTROL_FAILED',
      message: source?.message ?? String(error),
      ...(typeof source?.detail === 'string' ? { detail: source.detail } : {})
    } }
  }
}

/** Unwrap only in Renderer, after contextBridge has copied the plain result. */
export function unwrapBrowserRunResult(result: BrowserRunResult): BrowserScriptRunReport {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.report
}
