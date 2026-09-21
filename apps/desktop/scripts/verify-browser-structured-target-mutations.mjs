import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const file = 'apps/desktop/src/main/browser-structured-target.ts'
await verifyRendererSourceMutations({ name: 'browser-structured-target-mutations',
  tests: ['apps/desktop/test/browser-structured-target.test.ts'],
  sources: [file, 'apps/desktop/src/main/browser-page-snapshot.ts'],
  mutations: [
    {label:'selector-uses-page-world',file,before:'resolveWithinSelector(send, input.within, executionContextId)',after:'resolveWithinSelector(send, input.within)'},
    {label:'sender-substituted-for-actual-document',file,before:'frameId = described.node.frameId',after:'frameId = tree.frameTree.frame.id'},
    {label:'document-frame-verification-removed',file,before:'if (!described.node?.frameId)',after:'if (false)'},
    {label:'unknown-current-read-as-page-change',file,before:"throw new Error('Current isolated document could not be verified. The Browser remains usable; inspect it before retrying extraction.')",after:'return false'},
    {label:'document-exception-accepted-as-current',file,before:"response.exceptionDetails || typeof response.result?.value !== 'boolean'",after:"typeof response.result?.value !== 'boolean'"},
    {label:'original-document-url-not-checked',file,before:'arguments: [{ value: documentUrl }]',after:'arguments: [{ value: "https://fixture.invalid/document" }]'},
    {label:'backend-handles-not-released',file,before:'for (const objectId of objects) await send(\'Runtime.releaseObject\', { objectId }).catch(() => {})',after:'void objects'}
  ]
})
