import type { ParsedBook } from '../../normalize'
import type { BookResources } from '../../resources'
import type { SourceFile } from '../../source-file'
import type { openBookArchive } from '../../archive'
export type Archive = Awaited<ReturnType<typeof openBookArchive>>
export interface Environment { urls: BookResources; sanitizeDocument(doc: Document): void }
export type Parsed = ParsedBook & { transformTarget: EventTarget }
export type SliceFile = SourceFile
