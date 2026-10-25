import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react'

import { MobileNotice } from '../notices/MobileNotice'
import { useMobileWebReloadAction } from '../mobile-web/use-mobile-web-reload-action'

type LoadBoundaryProps = { active: boolean; label: string; onReturn(): void; children: ReactNode }
class LoadBoundary extends Component<LoadBoundaryProps, { failure: string | null }> {
  state = { failure: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
  render() {
    if (this.state.failure === null) return this.props.children
    return <LoadFailure active={this.props.active} label={this.props.label} failure={this.state.failure} onReturn={this.props.onReturn} />
  }
}

function LoadFailure({ active, label, failure, onReturn }: { active: boolean; label: string; failure: string; onReturn(): void }) {
  const { busy, issue, reload, cancel } = useMobileWebReloadAction(active)
  return <section className="mobile-deferred-surface" role="status">
    <p>{label}暂时无法打开。可保全当前内容后重新打开网页。</p>
    <details><summary>加载详情</summary><p>{failure}</p></details>
    <button type="button" className="mobile-text-button" disabled={busy} onClick={() => { void reload() }}>{busy ? '正在保全…' : '保全并重新打开网页'}</button>
    <button type="button" className="mobile-text-button" onClick={() => { cancel(); onReturn() }}>返回</button>
    {issue && <MobileNotice identity={[issue.message, issue.attempt]}>{issue.message}</MobileNotice>}
  </section>
}

/** Prepare a panel on first use, then retain its original mounted instance while hidden. */
export function deferMobileSurface<P extends object>(label: string, load: () => Promise<{ default: ComponentType<P> }>) {
  const Surface = lazy(load)
  return function DeferredMobileSurface({ loadWhen, onLoadReturn, ...props }: P & { loadWhen: boolean; onLoadReturn(): void }) {
    const [visited, setVisited] = useState(loadWhen)
    if (loadWhen && !visited) setVisited(true)
    if (!visited && !loadWhen) return null
    return <LoadBoundary active={loadWhen} label={label} onReturn={onLoadReturn}>
      <Suspense fallback={<section className="mobile-deferred-surface" role="status">
        <p>正在加载{label}…</p><button type="button" className="mobile-text-button" onClick={onLoadReturn}>返回</button>
      </section>}><Surface {...props as P} /></Suspense>
    </LoadBoundary>
  }
}
