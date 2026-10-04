import { lazy, Suspense, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { FileBuildKind } from '../../../../shared/file-build'
import { buildFileRegion, cancelFileRegionBuild, inspectFileRegionBuild, readFileRegionBuild, releaseFileRegionBuild, subscribeFileRegionBuild } from '../../lib/file-formats/build-file-region'

const PdfContent = lazy(async () => ({ default: (await import('../PdfContent')).PdfContent }))

/** Compilation is an explicit action on the original draft, not a preview side effect. */
export function BuildFilePreview({ regionId, kind, path, visible = true }: { regionId: string; kind: FileBuildKind; path: string; visible?: boolean }) {
  const subscribe = useCallback((listener: () => void) => subscribeFileRegionBuild(regionId, listener), [regionId])
  const read = useCallback(() => readFileRegionBuild(regionId), [regionId])
  const reading = useSyncExternalStore(subscribe, read, read)
  const result = reading?.result
  useEffect(() => {
    if (!visible) releaseFileRegionBuild(regionId)
    return () => releaseFileRegionBuild(regionId)
  }, [regionId, visible])
  useEffect(() => {
    if (!visible || result?.status !== 'running') return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await inspectFileRegionBuild(regionId, result.buildId)
      if (active) timer = setTimeout(() => { void poll() }, 500)
    }
    timer = setTimeout(() => { void poll() }, 500)
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [regionId, visible, result?.buildId, result?.status])
  if (!visible) return null
  return <div className="file-build-preview">
    <div className="file-build-preview__actions">
      <strong>{kind === 'latex' ? 'LaTeX' : 'Typst'} document</strong>
      {result?.status === 'running'
        ? <button type="button" className="small-button" onClick={() => { void cancelFileRegionBuild(regionId, result.buildId) }}>Cancel build</button>
        : <button type="button" className="small-button" onClick={() => { void buildFileRegion(regionId) }}>{result ? 'Build again' : 'Build current draft'}</button>}
      <span role="status">{result?.status === 'running' ? 'Building…' : result?.status ?? 'Build explicitly to preview the current draft.'}</span>
      {result?.status === 'unknown' && <><button type="button" className="small-button" onClick={() => { void inspectFileRegionBuild(regionId, result.buildId) }}>Refresh build status</button><button type="button" className="small-button" onClick={() => { void cancelFileRegionBuild(regionId, result.buildId) }}>Cancel build</button></>}
    </div>
    {(!result || result.status === 'unavailable') && <p className="file-build-preview__help">{kind === 'latex' ? 'Requires Tectonic on the original local Host and a complete offline package cache.' : 'Requires Typst on the original local Host.'} Install the tool on that Host, then retry. Remote document builds are currently unavailable.</p>}
    {result?.message && <div className="file-preview-state" role={result.status === 'failed' || result.status === 'unknown' ? 'alert' : 'status'}><span>{result.message}</span></div>}
    {result?.log && <details className="file-build-preview__log" open={result.status !== 'succeeded'}><summary>Build log</summary><pre>{result.log}</pre></details>}
    {result?.status === 'succeeded' && reading?.pdf && <div className="file-build-preview__artifact"><Suspense fallback={<div className="file-preview-state" role="status">Loading PDF reader…</div>}><PdfContent data={reading.pdf} name={path} visible={visible} /></Suspense></div>}
  </div>
}
