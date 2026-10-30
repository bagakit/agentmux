import { isAllowedTopFrameNavigation, type TopFrameOrigin } from './top-frame-navigation.js'

export type AppDocumentSources = { current: TopFrameOrigin | null; loading: TopFrameOrigin | null }

/** Only the original loader names sources. A completed navigation may confirm one of them,
 * independently of Renderer readiness; a failed load cannot revoke the document still serving. */
export class WorkbenchDocumentSources {
  private current: TopFrameOrigin | null = null
  private loading: TopFrameOrigin | null = null

  read(): AppDocumentSources { return { current: this.current, loading: this.loading } }

  begin(source: TopFrameOrigin): () => void {
    this.loading = source
    return () => { if (this.loading === source) this.loading = null }
  }

  committed(url: string): void {
    if (this.loading && isAllowedTopFrameNavigation(this.loading, url)) this.current = this.loading
  }

  allows(url: string): boolean { return appDocumentSourceAllows(this.read(), url) }
}

export function appDocumentSourceAllows(sources: AppDocumentSources, url: string): boolean {
  return Boolean(sources.current && isAllowedTopFrameNavigation(sources.current, url) ||
    sources.loading && isAllowedTopFrameNavigation(sources.loading, url))
}
