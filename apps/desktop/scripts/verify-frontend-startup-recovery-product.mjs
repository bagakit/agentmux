import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Freeze only this proof's sources. Concurrent unrelated UI work must not mix
// Renderer versions during compilation or invalidate an already compiled candidate.
const origin = path.resolve(import.meta.dirname, '../../..')
const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-frontend-source-'))
const evidence = path.resolve(process.argv[2] ?? path.join(origin, '.tmp/frontend-startup-recovery/last'))
const coreRoot = path.resolve(process.env.AGENTMUX_PROOF_CORE_ROOT ?? path.join(origin, 'packages/core'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceInputs = {}
const clone = async relative => {
  const destination = path.join(sourceRoot, relative)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(path.join(origin, relative), destination, { recursive: true, mode: fsConstants.COPYFILE_FICLONE })
  const record = async file => {
    const metadata = await fs.stat(file)
    if (metadata.isDirectory()) for (const child of await fs.readdir(file)) await record(path.join(file, child))
    else sourceInputs[path.relative(sourceRoot, file)] = hash(await fs.readFile(file))
  }
  await record(destination)
}
const link = async (target, destination) => { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.symlink(target, destination) }
const previousCoreRoot = process.env.AGENTMUX_PROOF_CORE_ROOT
await fs.mkdir(evidence, { recursive: true })
try {
  for (const relative of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'test/fixture-values.mjs', 'patches/@xterm__xterm@6.1.0-beta.303.patch',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/resources', 'apps/desktop/src', 'apps/desktop/test/helpers',
    'apps/desktop/scripts/fixtures/session-continuity', 'apps/desktop/scripts/fixtures/managed-session-recovery',
    'apps/desktop/scripts/fixtures/native-proof-bootstrap.cjs', 'apps/desktop/scripts/fixtures/terminal-wheel/xterm-instrumented.ts',
    'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/verify-session-continuity-product.mjs',
    'apps/desktop/scripts/verify-managed-session-recovery.mjs', 'apps/desktop/scripts/verify-frontend-startup-recovery-product.mjs',
    'packages/core/scripts/build.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs',
    'packages/client-ui/package.json', 'packages/client-ui/tsconfig.json', 'packages/client-ui/src', 'packages/client-ui/dist']) await clone(relative)
  await fs.copyFile(path.join(coreRoot, 'package.json'), path.join(sourceRoot, 'packages/core/package.json'))
  for (const name of ['src', 'dist', 'bin', 'vendor', 'node_modules']) await link(path.join(coreRoot, name), path.join(sourceRoot, 'packages/core', name))
  await link(path.join(origin, 'node_modules'), path.join(sourceRoot, 'node_modules'))
  await link(path.join(origin, 'packages/client-ui/node_modules'), path.join(sourceRoot, 'packages/client-ui/node_modules'))
  // Preserve dependency resolution while directing the workspace client-ui link
  // to its frozen sources. Dependencies remain single physical package instances.
  const originalModules = path.join(origin, 'apps/desktop/node_modules')
  const frozenModules = path.join(sourceRoot, 'apps/desktop/node_modules')
  await fs.mkdir(frozenModules, { recursive: true })
  for (const entry of await fs.readdir(originalModules)) {
    if (entry === '@agentmux') {
      for (const name of await fs.readdir(path.join(originalModules, entry))) await link(
        name === 'client-ui' ? path.join(sourceRoot, 'packages/client-ui') : name === 'core' ? coreRoot : await fs.realpath(path.join(originalModules, entry, name)),
        path.join(frozenModules, entry, name))
    } else await link(await fs.realpath(path.join(originalModules, entry)), path.join(frozenModules, entry))
  }
  await fs.writeFile(path.join(evidence, 'source-snapshot.json'), JSON.stringify({ schema: 'agentmux.frontend-product-source-snapshot.v1',
    origin, sourceRoot, coreRoot, inputs: sourceInputs,
    boundary: 'The receipt binds this immutable source snapshot and the exact private Core artifacts; concurrent mutable checkout files are not a final equality gate.' }, null, 2))
  process.env.AGENTMUX_PROOF_CORE_ROOT = coreRoot
  // Production App initialize -> startup recovery -> Main -> Core, across real Electron exits.
  process.env.AGENTMUX_MANAGED_SESSION_RECOVERY_PROOF = '1'
  process.env.AGENTMUX_FRONTEND_STARTUP_RECOVERY_PROOF = '1'
  await import(pathToFileURL(path.join(sourceRoot, 'apps/desktop/scripts/verify-session-continuity-product.mjs')).href)
} finally {
  if (previousCoreRoot === undefined) delete process.env.AGENTMUX_PROOF_CORE_ROOT
  else process.env.AGENTMUX_PROOF_CORE_ROOT = previousCoreRoot
  await fs.rm(sourceRoot, { recursive: true, force: true })
}
