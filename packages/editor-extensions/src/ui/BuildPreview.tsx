import '../styles/build-preview.css'
import '../styles/preview-common.css'
import { lazy, Suspense } from 'react'
import type { RandomAccessSource } from '../bytes'
const PdfReader = lazy(async () => ({ default: (await import('@agentmux/editor-extensions/pdf')).PdfReader }))

export type BuildPreviewResult = {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unavailable' | 'unknown' | 'stale' | 'missing' | 'unsupported'
  message?: string | null; log?: string
}
/** Presents the host's explicit compilation result; does not start or own a build. */
export function BuildPreview({kind,path,result,pdf,onBuild,onCancel,onInspect}: {
  kind: 'latex' | 'typst'; path: string; result?: BuildPreviewResult | undefined; pdf: RandomAccessSource | null
  onBuild(): unknown; onCancel(): unknown; onInspect(): unknown
}) {
  return <div className="file-build-preview">
    <div className="file-build-preview__actions">
      <strong>{kind === 'latex' ? 'LaTeX' : 'Typst'} document</strong>
      {result?.status === 'running'
        ? <button type="button" className="small-button" onClick={() => { void onCancel() }}>Cancel build</button>
        : <button type="button" className="small-button" onClick={() => { void onBuild() }}>{result ? 'Build again' : 'Build current draft'}</button>}
      <span role="status">{result?.status === 'running' ? 'Building…' : result?.status ?? 'Build explicitly to preview the current draft.'}</span>
      {result?.status === 'unknown' && <><button type="button" className="small-button" onClick={() => { void onInspect() }}>Refresh build status</button><button type="button" className="small-button" onClick={() => { void onCancel() }}>Cancel build</button></>}
    </div>
    {(!result || result.status === 'unavailable') && <p className="file-build-preview__help">{kind === 'latex' ? 'Requires Tectonic on the original local Host and a complete offline package cache.' : 'Requires Typst on the original local Host.'} Install the tool on that Host, then retry. Remote document builds are currently unavailable.</p>}
    {result?.message && <div className="file-preview-state" role={result.status === 'failed' || result.status === 'unknown' ? 'alert' : 'status'}><span>{result.message}</span></div>}
    {result?.log && <details className="file-build-preview__log" open={result.status !== 'succeeded'}><summary>Build log</summary><pre>{result.log}</pre></details>}
    {result?.status === 'succeeded' && pdf && <div className="file-build-preview__artifact"><Suspense fallback={<div className="file-preview-state" role="status">Loading PDF reader…</div>}><PdfReader source={pdf} name={path} visible /></Suspense></div>}
  </div>
}
