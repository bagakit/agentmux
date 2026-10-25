import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { analyseV8Profile, parseV8ProfileBytes, summariseV8Profile, V8_PROFILE_MAX_BYTES,
  type V8ProfileAnalysis, type V8ProfileArtifactSource } from '@agentmux/core/control'
import { PerformanceProfileView } from './PerformanceProfileView'
import { downloadPerformanceBlob, downloadPerformanceJSON } from './performance-export'

type ImportedProfile = { name: string; original: Blob; source: V8ProfileArtifactSource; analysis: V8ProfileAnalysis }
type ImportFailure = { name: string; reason: string; sha256?: string }

/** One explicitly selected file, independent of live observations and capture owners. */
export const PerformanceProfileImport = memo(function PerformanceProfileImport() {
  const [imported, setImported] = useState<ImportedProfile | null>(null)
  const [error, setError] = useState<ImportFailure | null>(null), [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null), pending = useRef<{ reader: FileReader } | null>(null)
  const cancelRead = () => {
    const request = pending.current; pending.current = null
    if (!request) return
    request.reader.onload = request.reader.onerror = request.reader.onabort = null
    if (request.reader.readyState === FileReader.LOADING) request.reader.abort()
  }
  useEffect(() => cancelRead, [])
  const clear = () => { cancelRead(); setBusy(false); setImported(null); setError(null) }
  const importFile = (file: File) => {
    if (pending.current) return
    if (file.size > V8_PROFILE_MAX_BYTES) {
      setError({ name: file.name, reason: `Select a profile up to ${V8_PROFILE_MAX_BYTES / 1048576} MiB.` }); return
    }
    const request = { reader: new FileReader() }, reader = request.reader
    pending.current = request; setBusy(true); setError(null)
    const finish = () => {
      reader.onload = reader.onerror = reader.onabort = null
      if (pending.current !== request) return
      pending.current = null; setBusy(false)
    }
    const failRead = () => {
      if (pending.current === request) setError({ name: file.name, reason: 'The selected file could not be read.' })
      finish()
    }
    reader.onerror = failRead
    reader.onabort = finish
    reader.onload = async () => {
      let sha256: string | undefined
      try {
        const bytes = reader.result
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size)
          throw new Error('The selected file changed or could not be read completely.')
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        if (pending.current !== request) return
        sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
        const analysis = analyseV8Profile(parseV8ProfileBytes(new Uint8Array(bytes)))
        if (!analysis.data) throw new Error(analysis.reason)
        setImported({ name: file.name, original: new Blob([bytes], { type: 'application/json' }),
          source: { sha256, bytes: bytes.byteLength, captureIdentity: 'unavailable-in-bare-profile' }, analysis: analysis.data })
      } catch (reason) {
        if (pending.current === request) setError({ name: file.name,
          reason: reason instanceof Error ? reason.message : 'The selected profile could not be analysed.', ...(sha256 ? { sha256 } : {}) })
      } finally { finish() }
    }
    // Limit the actual read as well as the selected File metadata.
    try { reader.readAsArrayBuffer(file.slice(0, V8_PROFILE_MAX_BYTES + 1)) }
    catch { failRead() }
  }
  const report = useMemo(() => imported ? summariseV8Profile({ data: imported.analysis, reason: null }, imported.source) : null, [imported])
  return <details className="performance-disclosure" data-performance-profile-import>
    <summary>Saved CPU profile <span>Local analysis</span></summary>
    <p className="performance-note">Open an exported .cpuprofile to inspect its samples. The file stays on this device; importing does not start a capture.</p>
    <input ref={input} type="file" hidden accept=".cpuprofile,application/json" aria-label="Choose saved CPU profile" disabled={busy}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) importFile(file) }} />
    <div className="performance-capture-actions">
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>Import CPU profile</button>
      {imported || busy || error ? <button type="button" onClick={clear}>Clear imported profile</button> : null}
    </div>
    {busy ? <p className="performance-state" role="status">Reading the selected local file…</p> : null}
    {error ? <div className="performance-state" data-tone="warning" role="alert"><strong>{error.name}</strong>: {error.reason}
      {imported ? ' The previous imported profile remains below.' : ''}
      {error.sha256 ? <details className="performance-disclosure"><summary>Attempt source</summary><span>SHA-256 {error.sha256}</span></details> : null}
    </div> : null}
    {imported ? <section aria-label="Imported CPU profile">
      <div className="performance-section-heading"><strong>Local CPU profile</strong><span title={imported.name}>{imported.name}</span></div>
      <p className="performance-state">Local file · process and build unverified. This is separate from the current window and its capture receipts.</p>
      <div className="performance-capture-actions">
        <button type="button" onClick={() => downloadPerformanceBlob(imported.original, imported.name)}>Export original profile</button>
        <button type="button" onClick={() => downloadPerformanceJSON(report, 'profile-analysis.json')}>Export technical report</button>
      </div>
      <PerformanceProfileView key={imported.source.sha256} analysis={imported.analysis} />
      <details className="performance-disclosure"><summary>File source</summary><p className="performance-note">{imported.source.bytes} original bytes<br />SHA-256 {imported.source.sha256}<br />No capture identity is present in the bare profile.</p></details>
    </section> : null}
  </details>
})
