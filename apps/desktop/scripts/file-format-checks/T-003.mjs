export { tests, sources, owningConfig } from './T-002.mjs'
export const mutations = [
  { label: 'yaml-last-documents-lost', file: 'packages/editor-extensions/src/engines/data-config.ts', before: 'documents.slice(0, DATA_PREVIEW_MAX_ROWS)', after: 'documents.slice(0, 1)' },
  { label: 'yaml-undefined-alias-hidden', file: 'packages/editor-extensions/src/engines/data-config.ts', before: 'if (!anchors.has(node.source))', after: 'if (false)' },
  { label: 'toml-integer-precision-lost', file: 'packages/editor-extensions/src/engines/data-config.ts', before: 'integersAsBigInt: true, useLegacyDate: false', after: 'integersAsBigInt: false, useLegacyDate: false' }
]
