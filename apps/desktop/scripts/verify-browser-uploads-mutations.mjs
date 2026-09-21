import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const file='apps/desktop/src/main/browser-uploads.ts'
await verifyRendererSourceMutations({name:'browser-uploads-mutations',tests:['apps/desktop/test/browser-uploads.test.ts'],
  sources:[file,'apps/desktop/src/shared/browser-upload.ts','apps/desktop/src/main/workspace-files.ts','apps/desktop/src/shared/workspace-file-bytes.ts'],
  mutations:[
    {label:'upload-reuses-backend-instead-of-exact-object',file,before:"'DOM.setFileInputFiles', { objectId: context.target.objectId, files: staged }",after:"'DOM.setFileInputFiles', { backendNodeId: 42, files: staged }"},
    {label:'file-list-verification-disconnected',file,before:'observed.exceptionDetails || JSON.stringify(observed.result?.value) !== JSON.stringify(selection.files.map(file => ({ name: file.name, byteLength: file.byteLength })))',after:'false'},
    {label:'single-file-guard-removed',file,before:'if (paths.length > 1 && !target.multiple)',after:'if (false)'},
    {label:'navigation-check-removed',file,before:'context.currentNavigationId() !== context.navigationId',after:'false'},
    {label:'incomplete-file-snapshot-accepted',file,before:'snapshot.bytes.length !== snapshot.totalBytes || snapshot.totalBytes > WORKSPACE_FILE_MAX_BYTES || snapshot.nextOffset !== null',after:'false'},
    {label:'aggregate-upload-budget-removed',file,before:'this.retainedBytes + snapshot.totalBytes > MAX_RETAINED_BYTES',after:'false'},
    {label:'unknown-action-deletes-possible-file-list',file,before:'if (!actionStarted) await this.remove(selection)',after:'if (true) await this.remove(selection)'},
    {label:'unrelated-browser-releases-selected-bytes',file,before:'const selections = [...(this.selections.get(browserId) ?? [])]',after:'const selections = [...this.selections.values()].flatMap(selected => [...selected])'},
    {label:'old-cleanup-consumes-new-document-selection',file,before:'async releaseBrowser(browserId: string): Promise<void> {',after:'async releaseBrowser(browserId: string): Promise<void> {\n    for (const selection of this.selections.get(browserId) ?? []) await this.remove(selection); return;'},
    {label:'uploads-live-workspace-file-instead-of-pinned-snapshot',file,before:'objectId: context.target.objectId, files: staged',after:'objectId: context.target.objectId, files: (paths as string[]).map(path => join(workspace.path, path))'},
    {label:'changed-target-not-rechecked',file,before:'const currentTarget = await inspect()',after:'const currentTarget = target'}
  ]})
