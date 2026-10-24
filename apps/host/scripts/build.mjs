import { buildWorkspaceMoveHelper } from './build-workspace-move-helper.mjs'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { copyFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
await buildWorkspaceMoveHelper()
await build({ entryPoints: ['index', 'goals', 'goal-projection', 'continuous-progress-loop-manager', 'goal-runtime', 'goal-delegation-owner', 'goal-delegation-attention', 'goal-start-responsibility', 'goal-responsibility-owner', 'goal-patrol-owner', 'goal-dispatch-input', 'continuous-progress-delivery', 'goal-project-context', 'goal-pmo-origin', 'demand-participation', 'name-history', 'agent-schedule-check-in', 'continuous-progress-loop-store', 'continuous-progress-task-source', 'goal-delegation-materials', 'goal-role-input', 'goals-preferences', 'workspace-projects', 'client-incident-archive', 'mobile-web-report-owner', 'settings-resource-read', 'theme-observation', 'content-owner', 'file-read-owner', 'topic-knowledge', 'topic-spatial-owner', 'topic-search-history', 'note-file-writer', 'note-history-actions', 'note-title-file-writer', 'note-corpus-reader', 'notebook-observation-owner', 'note-shared-block-owner', 'note-shared-undo-owner', 'note-shared-file-delete-owner', 'topic-categories', 'notes-library', 'note-resource-write', 'content-types', 'macos-service', 'presentation-configuration', 'object-avatars', 'object-avatar-files', 'mote-avatar-state', 'mote-avatar-read', 'host-configuration', 'file-resource', 'file-resource-model', 'file-upload-owner', 'ordinary-files', 'workspace-file-bytes', 'mote-connection-preferences', 'mote-connection-target', 'mote-resources', 'mote-chat-agents', 'mote-model', 'credential-administration'].map(name => resolve(root, 'src', name + '.ts')),
  outdir: resolve(root, 'dist'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
await new Promise((yes, no) => {
  const child = spawn(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--emitDeclarationOnly', '-p', resolve(root, 'tsconfig.json')],
    { stdio: 'inherit', env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
  child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(new Error('Host declarations did not compile.')))
})
for (const entry of await readdir(resolve(root, 'src'))) if (entry.endsWith('.d.mts')) await copyFile(resolve(root, 'src', entry), resolve(root, 'dist', entry))
