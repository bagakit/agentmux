import { crashRecordFrom, type CrashRecord } from './crash-capture.js'

/** Cleanup has already attempted every owner. Local reporting must never prevent the requested quit. */
export function reportQuitDisposalFailure(error: unknown, io: {
  persistDiagnostic(record: CrashRecord): void
  stderr: { write(chunk: string): unknown }
  appVersion: string
  pid: number
}): void {
  const record = crashRecordFrom({ kind: 'quit-disposal-failure', error, appVersion: io.appVersion, pid: io.pid }, Date.now())
  try {
    io.persistDiagnostic(record)
  } catch (diagnosticError) {
    try { io.stderr.write(`Quit diagnostic persistence failed: ${String(diagnosticError)}\n`) } catch { /* Exit remains available even if stderr is closed. */ }
  }
  try { io.stderr.write(`${record.summary}\n${record.detail ?? ''}\n`) } catch { /* The persisted local log remains the recovery path. */ }
}
