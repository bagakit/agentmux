import { buildWorkspaceMoveHelper } from './build-workspace-move-helper.mjs'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { copyFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
await buildWorkspaceMoveHelper()
await build({ entryPoints: ['index', 'macos-service', 'presentation-configuration', 'object-avatars', 'object-avatar-files', 'mote-avatar-state', 'mote-avatar-read', 'host-configuration', 'file-resource', 'file-resource-model', 'file-upload-owner', 'ordinary-files', 'workspace-file-bytes', 'mote-connection-preferences', 'mote-connection-target', 'mote-resources', 'mote-chat-agents', 'mote-model', 'credential-administration'].map(name => resolve(root, 'src', name + '.ts')),
  outdir: resolve(root, 'dist'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
await new Promise((yes, no) => {
  const child = spawn(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--emitDeclarationOnly', '-p', resolve(root, 'tsconfig.json')],
    { stdio: 'inherit', env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
  child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(new Error('Host declarations did not compile.')))
})
for (const entry of await readdir(resolve(root, 'src'))) if (entry.endsWith('.d.mts')) await copyFile(resolve(root, 'src', entry), resolve(root, 'dist', entry))
