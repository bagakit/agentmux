import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const owner = 'apps/desktop/src/main/browser-task-assets.ts'
const editor = 'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx'
await verifyRendererSourceMutations({
  name: 'browser-task-completion-declaration-mutations',
  tests: ['apps/desktop/test/browser-task-completion-declaration.test.ts', 'apps/desktop/test/browser-task-completion-ui.test.tsx'],
  sources: [owner, editor, 'apps/desktop/src/shared/browser-task-assets.ts'],
  mutations: [
    { label: 'declaration-unknown-fields-retained', file: owner, before: "Object.keys(completion).some(key => key !== 'criteria')", after: 'false' },
    { label: 'download-unknown-fields-retained', file: owner, before: "Object.keys(item).some(key => !['kind', 'stepId', 'path'].includes(key))", after: 'false' },
    { label: 'verification-ui-disconnected', file: editor, before: 'onVerify(actualRun.id, event)', after: "Promise.reject(new Error('disconnected'))" }
  ]
})
