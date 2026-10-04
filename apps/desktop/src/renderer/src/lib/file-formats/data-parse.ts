import type { StructuredPreview } from './data-model'

export type StructuredDataKind = 'jsonl' | 'yaml' | 'toml'

/** Imports only the parser needed by this visible reader. Input admission lives in each parser. */
export async function readStructuredPreview(kind: StructuredDataKind, content: string): Promise<StructuredPreview> {
  switch (kind) {
    case 'jsonl': return (await import('./data-jsonl')).readJsonLines(content)
    case 'yaml': return (await import('./data-config')).readYamlPreview(content)
    case 'toml': return (await import('./data-config')).readTomlPreview(content)
  }
}
