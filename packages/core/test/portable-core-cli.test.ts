import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createPortableCoreArtifact } from '../src/portable-core-artifact.js'

const exec = promisify(execFile)
it('materializes an offline artifact with an independent amux entry and content-bound bytes', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-portable-cli-"))
  try {
    const artifact = await createPortableCoreArtifact(root)
    const entry = artifact.files.find(file => file.path === 'bin/amux')
    expect(entry).toBeDefined()
    expect(artifact.files.map(file => file.path)).not.toContain('bin/agentmux')
    expect(entry!.mode & 0o111).not.toBe(0)
    const path = join(root, 'core', 'bin', 'amux')
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(entry!.sha256)
    const reply = await exec(path, ['system', 'endpoint'])
    expect(JSON.parse(reply.stdout)).toMatchObject({ ok: true, operation: 'system.endpoint' })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120_000)
