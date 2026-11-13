import type { BookFormat, BookLocation, BookMetadata, BookTocItem } from '../books/types'

/** A reading preference on the original File Region, never a source capability. */
export interface BookReadingPosition { section: number; sectionId: string; progress: number }
export interface BookSnapshot { metadata: BookMetadata; toc: BookTocItem[]; sections: { id: string; size: number }[]; layout: 'reflowable' | 'pre-paginated'; direction: 'ltr' | 'rtl' }
export interface BookOpenRequest { sourceId: string; size: number; format: BookFormat; name: string }
export interface OpenedBook { id: string; book: BookSnapshot }
export interface BookReaderHost {
  open(): Promise<OpenedBook>
  load(id: string, section: number): Promise<string>
  unload(id: string, section: number): Promise<void>
  resolve(id: string, href: string, fromSection?: number): Promise<BookLocation | null>
  close(id: string): Promise<void>
}
export interface BookBytesPort {
  read(operation: string, offset: number, length: number): Promise<{ status: 'read'; bytes: Uint8Array } | { status: string; code: string; message: string }>
  cancel(operation: string): Promise<void>
  entries(operation: string): Promise<{ status: 'read'; value: {path: string; size: number}[] } | {status: string; code: string; message: string}>
  entry(operation: string, path: string): Promise<{ status: 'read'; value: Uint8Array } | {status: string; code: string; message: string}>
}
