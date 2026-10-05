export const owningConfig = 'apps/desktop/test/file-format-integration.config.mts'
export const tests = ['apps/desktop/test/file-format-integration.test.tsx', 'apps/desktop/test/probe-process-cleanup.test.ts', 'apps/desktop/test/probe-process-identity.test.ts']
export const sources = ['apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx', 'apps/desktop/src/shared/workspace-file-format.ts',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/StructuredDataPreview.tsx', 'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.tsx',
  'apps/desktop/src/renderer/src/lib/file-formats/data-structured-request.ts', 'apps/desktop/src/renderer/src/lib/file-formats/data-structured.worker.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-notebook.ts', 'apps/desktop/src/renderer/src/lib/file-formats/data-notebook.worker.ts',
  'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/test/probe-process.test.ts']
export const mutations = [
  { label: 'structured-production-dispatch-disconnected', file: sources[1], before: 'return <StructuredDataPreview content={content} kind={kind} visible={visible} ownerKey={`${workspaceId}:${path}`} />', after: 'return null' },
  { label: 'notebook-production-dispatch-disconnected', file: sources[1], before: 'return <NotebookFilePreview content={content} visible={visible} ownerKey={`${workspaceId}:${path}`} />', after: 'return null' },
  { label: 'preview-current-draft-disconnected', file: sources[0], before: 'kind={format.sourcePreview} content={doc.content} path={surface.path}', after: 'kind={format.sourcePreview} content={"DISCONNECTED_CURRENT_DRAFT"} path={surface.path}' },
  { label: 'departed-probe-group-signalled', file: 'apps/desktop/scripts/probe-process.mjs', before: '  let remaining = await listProbeProcesses(groupId, temporaryRoot)\n  if (!remaining.length) return', after: "  process.kill(-groupId, 'SIGTERM')\n  let remaining = await listProbeProcesses(groupId, temporaryRoot)\n  if (!remaining.length) return" },
  { label: 'probe-signals-reused-pid', file: 'apps/desktop/scripts/probe-process.mjs', before: "for (const pid of remaining) await signalOwnedProbeProcess(pid, temporaryRoot, 'SIGTERM', groupId)", after: "for (const pid of remaining) process.kill(pid, 'SIGTERM')" },
  { label: 'probe-cleanup-failure-waits-forever', file: 'apps/desktop/scripts/probe-process.mjs', before: 'const exitCode = await Promise.race([childExit, cleanupFailure])', after: 'const exitCode = await childExit' }
]
