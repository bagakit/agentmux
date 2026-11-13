import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createPortableCoreArtifact } from '../src/portable-core-artifact.js'

const exec = promisify(execFile)
const repository = join(import.meta.dirname, '../../..')
it('materializes an offline artifact with an independent amux entry and content-bound bytes', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-portable-cli-"))
  try {
    // The packaging owner assembles the same runtime Core the App bundles.
    const { materializeRuntimeCore } = await import(pathToFileURL(join(repository, 'scripts/package-dependencies.mjs')).href)
    const runtime = await materializeRuntimeCore(repository, join(root, 'runtime-core'), { sourceCommit: null })
    const artifact = await createPortableCoreArtifact(join(root, 'artifact'), runtime)
    const entry = artifact.files.find(file => file.path === 'bin/amux')
    expect(entry).toBeDefined()
    expect(artifact.files.map(file => file.path)).not.toContain('bin/agentmux')
    expect(entry!.mode & 0o111).not.toBe(0)
    const path = join(root, 'artifact', 'core', 'bin', 'amux')
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(entry!.sha256)
    const reply = await exec(path, ['system', 'endpoint'])
    expect(JSON.parse(reply.stdout)).toMatchObject({ ok: true, operation: 'system.endpoint' })
    // Workspace sources, tests and development files never reach a remote Host.
    expect(artifact.files.filter(file => /node_modules\/@agentmux\/[^/]+\/(src|test)\//u.test(file.path) || /\.(d\.ts|js\.map)$/u.test(file.path))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
}, 180_000)
