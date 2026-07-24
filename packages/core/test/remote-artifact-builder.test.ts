import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentMuxRemoteArtifact } from '../src/remote-artifact-builder.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const supported = (
  (process.platform === 'darwin' || process.platform === 'linux') &&
  (process.arch === 'arm64' || process.arch === 'x64')
)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe.runIf(supported)('AgentMux remote artifact builder', () => {
  it('creates a self-contained daemon archive for one explicit platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-artifact-builder-test-'))
    roots.push(root)
    const platform = `${process.platform}-${process.arch}` as 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64'
    const artifact = await createAgentMuxRemoteArtifact({
      outputPath: join(root, 'agentmux-remote.tgz'),
      buildIdentity: 'artifact-test',
      platform
    })
    await execFileAsync('tar', ['-xzf', artifact.archivePath, '-C', root])
    const manifest = JSON.parse(await readFile(join(root, 'agentmux-artifact.json'), 'utf8'))

    expect(artifact).toMatchObject({ buildIdentity: 'artifact-test', platform })
    expect(manifest).toEqual({
      schema: 'agentmux.remote-artifact.v1',
      buildIdentity: 'artifact-test',
      platform,
      entrypoint: 'package/dist/agentmuxd.js'
    })
    await expect(stat(join(root, 'package', 'dist', 'agentmuxd.js'))).resolves.toMatchObject({})
    await expect(stat(join(root, 'package', 'node_modules', 'node-pty', 'prebuilds', platform, 'pty.node')))
      .resolves.toMatchObject({})
    await expect(stat(join(root, 'package', 'node_modules', 'node-pty', 'LICENSE'))).resolves.toMatchObject({})
    await expect(stat(join(root, 'package', 'dist', 'tmux-client.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform === 'darwin') {
      const helper = await stat(join(root, 'package', 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper'))
      expect(helper.mode & 0o111).not.toBe(0)
    }
  }, 15_000)

  it('does not overwrite an existing output file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-artifact-existing-test-'))
    roots.push(root)
    const outputPath = join(root, 'agentmux-remote.tgz')
    await writeFile(outputPath, 'keep-me')
    await expect(createAgentMuxRemoteArtifact({
      outputPath,
      buildIdentity: 'artifact-existing'
    })).rejects.toMatchObject({ code: 'REMOTE_ARTIFACT_EXISTS' })
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('keep-me')
  })

  it('materializes the declared Native prebuild for every supported target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-artifact-platforms-test-'))
    roots.push(root)
    const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
    for (const platform of platforms) {
      const artifact = await createAgentMuxRemoteArtifact({
        outputPath: join(root, `${platform}.tgz`),
        buildIdentity: `artifact-${platform}`,
        platform
      })
      const listed = await execFileAsync('tar', ['-tzf', artifact.archivePath])
      expect(listed.stdout).toContain(`package/node_modules/node-pty/prebuilds/${platform}/pty.node`)
      for (const other of platforms.filter((candidate) => candidate !== platform)) {
        expect(listed.stdout).not.toContain(`package/node_modules/node-pty/prebuilds/${other}/`)
      }
    }
  }, 30_000)
})
