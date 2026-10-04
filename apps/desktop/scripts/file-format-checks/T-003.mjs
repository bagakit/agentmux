export { tests, sources, owningConfig } from './T-002.mjs'
export const mutations = [
  { label: 'yaml-last-documents-lost', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-config.ts', before: 'documents.slice(0, DATA_PREVIEW_MAX_ROWS)', after: 'documents.slice(0, 1)' },
  { label: 'yaml-undefined-alias-hidden', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-config.ts', before: 'if (!anchors.has(node.source))', after: 'if (false)' },
  { label: 'toml-integer-precision-lost', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-config.ts', before: 'integersAsBigInt: true, useLegacyDate: false', after: 'integersAsBigInt: false, useLegacyDate: false' }
]
