/** A transient diagram job. File identity, source and persistence stay with the caller. */
export type FileDiagramKind = 'mermaid' | 'drawio' | 'plantuml'
export type FileDiagramRequest = {
  id: string
  kind: FileDiagramKind
  content: string
  theme: 'light' | 'dark'
  page?: number
}
export type FileDiagramResult = { id: string; svg: string; pageCount?: number; error?: string }
