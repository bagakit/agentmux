import { Component, Suspense, lazy, useMemo, useReducer, useState, type ComponentType, type ReactNode } from 'react'

type LoadBoundaryProps = { label: string; onRetry(): void; onReturn(): void; children: ReactNode }
class LoadBoundary extends Component<LoadBoundaryProps, { failure: string | null }> {
  state = { failure: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
  render() {
    if (this.state.failure === null) return this.props.children
    return <section className="mobile-deferred-surface" role="status">
      <p>{this.props.label}暂时无法打开，其他工作面仍可使用。</p>
      <details><summary>加载详情</summary><p>{this.state.failure}</p></details>
      <button type="button" className="mobile-text-button" onClick={this.props.onRetry}>重新加载此面板</button>
      <button type="button" className="mobile-text-button" onClick={this.props.onReturn}>返回</button>
    </section>
  }
}

/** Prepare a panel on first use, then retain its original mounted instance while hidden. */
export function deferMobileSurface<P extends object>(label: string, load: () => Promise<{ default: ComponentType<P> }>) {
  return function DeferredMobileSurface({ loadWhen, onLoadReturn, ...props }: P & { loadWhen: boolean; onLoadReturn(): void }) {
    const [visited, setVisited] = useState(loadWhen)
    if (loadWhen && !visited) setVisited(true)
    const [revision, retry] = useReducer(value => value + 1, 0)
    // A failed React.lazy caches its rejection. Explicit panel retry starts a
    // fresh module read; it never refreshes the page or repeats a business action.
    const Surface = useMemo(() => lazy(load), [revision])
    if (!visited && !loadWhen) return null
    return <LoadBoundary key={revision} label={label} onRetry={retry} onReturn={onLoadReturn}>
      <Suspense fallback={<section className="mobile-deferred-surface" role="status">
        <p>正在加载{label}…</p><button type="button" className="mobile-text-button" onClick={onLoadReturn}>返回</button>
      </section>}><Surface {...props as P} /></Suspense>
    </LoadBoundary>
  }
}
