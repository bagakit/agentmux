import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Code2, X } from 'lucide-react'
import type { ToolkitDesktopApi, ToolkitScript } from '../../../../shared/toolkit'

/** 官方资产只读查看，不提供编辑、保存或执行入口。 */
export function PerformanceScript({ api, back, close }: { api: Pick<ToolkitDesktopApi, 'script'>; back(): void; close(): void }) {
  const [script, setScript] = useState<ToolkitScript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { first.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    let connected = true
    void api.script('performance').then(value => { if (connected) setScript(value) }).catch(reason => {
      if (connected) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { connected = false }
  }, [api])
  return <>
    <header className="performance-header"><div className="performance-title"><button ref={first} type="button" className="performance-icon-button" aria-label="Back to Performance" onClick={back}><ArrowLeft size={14} /></button>
      <Code2 size={15} /><h2>Official script</h2><span className="performance-official">Read-only</span></div>
      <button type="button" className="performance-icon-button" aria-label="Close Performance" data-toolkit-close onClick={close}><X size={14} /></button></header>
    <div className="performance-body performance-script">
      {script ? <><p className="performance-note">Performance observes resources through the public metrics API.</p>
        <textarea readOnly spellCheck={false} aria-label="Official Performance script source" value={script.text} />
        <details className="performance-disclosure"><summary>Script identity</summary><dl className="performance-facts"><dt>Path</dt><dd>{script.path}</dd><dt>SHA-256</dt><dd>{script.sha256}</dd></dl></details></>
        : <p className="performance-state" data-tone={error ? 'warning' : 'neutral'}>{error ?? 'Loading the official script…'}</p>}
    </div>
  </>
}
