/** Pure reader contracts. A host grants an original byte source; these objects grant no filesystem or network access. */
export type BookFormat = 'epub' | 'mobi' | 'azw3' | 'fb2' | 'cbz' | 'cbr' | 'djvu'

export interface BookMetadata {
  title: string
  author?: string
  language?: string
}

export interface BookTocItem {
  label: string
  href: string
  children?: BookTocItem[]
}

export interface BookLocation {
  index: number
  fragment?: string
  selector?: string
}

export interface BookSection {
  readonly id: string
  readonly size: number
  /** Load only this section and its referenced resources. Render in an unprivileged sandbox, never the App document. */
  load(): Promise<string>
  /** Release this section's temporary document and resource references. */
  unload(): void
}

export interface ReaderBook {
  readonly metadata: BookMetadata
  readonly toc: BookTocItem[]
  readonly sections: BookSection[]
  readonly layout: 'reflowable' | 'pre-paginated'
  readonly direction: 'ltr' | 'rtl'
  resolveHref(href: string, fromSection?: number): BookLocation | null | Promise<BookLocation | null>
  /** Abort outstanding byte reads and release every owned document/resource URL. Does not close the host's source. */
  destroy(): void
}
