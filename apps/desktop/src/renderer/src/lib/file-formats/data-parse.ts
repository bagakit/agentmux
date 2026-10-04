import type { StructuredPreview } from './data-model'

export type StructuredDataKind = 'jsonl' | 'yaml' | 'toml'

/** Imports only the parser needed by this visible reader. Input admission lives in each parser. */
export async function readStructuredPreview(kind: StructuredDataKind, content: string, signal?: AbortSignal): Promise<StructuredPreview> {
  signal?.throwIfAborted()
  let parse: (content: string) => StructuredPreview
  switch (kind) {
    case 'jsonl': parse = (await import('./data-jsonl')).readJsonLines; break
    case 'yaml': parse = (await import('./data-config')).readYamlPreview; break
    case 'toml': parse = (await import('./data-config')).readTomlPreview; break
  }
  signal?.throwIfAborted()
  return parse(content)
}
