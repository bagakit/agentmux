import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@ctxmux/sdk'
import { assertAgentMuxRuntimeCompatibility } from '../src/ctxmux-run-adapter.js'
import { ctxmuxManifestSha256, supportedCtxmuxArtifactPlatform } from '../src/runtime-paths.js'
import contract from '../src/ctxmux-artifact-contract.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const installationRoots: string[] = []
afterEach(async () => {
  await Promise.all(installationRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('qualified Darwin and Linux Core package', () => {
  it('binds every shipped native binary and SDK to one accepted source and protocol', async () => {
    const platforms = Object.keys(contract.manifests)
    expect(platforms).toEqual(['darwin-arm64', 'linux-x64'])
    const sdkHashes = new Set<string>()
    for (const platform of platforms) {
      const artifactRoot = new URL(`../vendor/ctxmux/${platform}/`, import.meta.url)
      const bytes = await readFile(new URL('manifest.json', artifactRoot))
      expect(digest(bytes)).toBe(contract.manifests[platform as keyof typeof contract.manifests])
      const manifest = JSON.parse(bytes.toString())
      expect(manifest.source).toMatchObject({ ...contract.source, worktree_clean: true })
      expect(manifest.product).toEqual({ version: contract.version, protocol: PROTOCOL_VERSION })
      expect(`${manifest.support.platform}-${manifest.support.architecture}`).toBe(platform)
      expect(manifest.binaries.map((entry: { name: string }) => entry.name)).toEqual(['ctxmux', 'ctxmuxd'])
      for (const artifact of [manifest.sdk.archive, ...manifest.binaries]) {
        const path = new URL(artifact.path, artifactRoot)
        const contents = await readFile(path)
        expect(contents.byteLength).toBe(artifact.bytes)
        expect(digest(contents)).toBe(artifact.sha256)
        expect((await stat(path)).mode & 0o777).toBe(Number.parseInt(artifact.mode, 8))
      }
      sdkHashes.add(manifest.sdk.archive.sha256)
    }
    expect(sdkHashes.size).toBe(1)
  })

  it('admits precisely the qualified host pairs and rejects unsupported combinations', () => {
    expect(supportedCtxmuxArtifactPlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(supportedCtxmuxArtifactPlatform('linux', 'x64')).toBe('linux-x64')
    for (const [platform, architecture] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'x64']]) {
      expect(supportedCtxmuxArtifactPlatform(platform, architecture)).toBeNull()
      expect(() => ctxmuxManifestSha256(platform, architecture)).toThrow('no qualified ctxmux artifacts')
    }
    const owner = {
      daemonInstanceId: 'instance', runtimeId: 'runtime', runtimeIdPersistence: 'state_dir' as const,
      buildId: `ctxmuxd/${contract.version}`, protocolGeneration: PROTOCOL_VERSION,
      capabilities: {
        'native.start': 1, 'native.recoverable_input': 1, 'native.recoverable_stop': 1,
        'services.persistent_state': 1, 'services.planned_exec_upgrade_continuity': 1
      }
    }
    for (const identity of [{ platform: 'macos', arch: 'aarch64' }, { platform: 'linux', arch: 'x86_64' }]) {
      expect(() => assertAgentMuxRuntimeCompatibility({ ...owner, ...identity })).not.toThrow()
    }
    expect(() => assertAgentMuxRuntimeCompatibility({ ...owner, platform: 'linux', arch: 'aarch64' }))
      .toThrow(expect.objectContaining({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' }))
  })

  it('publishes platform dispatchers and executes the actual host binaries', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    // Portable Core APIs remain installable; native execution keeps its qualified host guard.
    expect(manifest.os).toBeUndefined()
    expect(manifest.cpu).toBeUndefined()
    expect(manifest.bin).toMatchObject({ ctxmux: './bin/ctxmux', ctxmuxd: './bin/ctxmuxd', 'agentmux-runtime': './bin/agentmux-runtime' })
    expect(manifest.scripts.postinstall).toBe('node bin/install-ctxmux.mjs')
    expect(supportedCtxmuxArtifactPlatform()).toBe(`${process.platform}-${process.arch}`)
    for (const name of ['ctxmux', 'ctxmuxd']) {
      const result = await execFileAsync(`${packageRoot}bin/${name}`, ['--version'])
      expect(result.stdout).toMatch(new RegExp(`^${name} ${contract.version.replaceAll('.', '\\.')}`))
      expect(result.stdout).toContain(`protocol ${PROTOCOL_VERSION}`)
    }
  }, 30_000)

  it('restores npm-normalized native modes from verified package contents', async () => {
    const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/agentmux-native-install-"))
    installationRoots.push(root)
    await cp(join(packageRoot, 'vendor'), join(root, 'vendor'), { recursive: true })
    await cp(join(packageRoot, 'bin'), join(root, 'bin'), { recursive: true })
    await mkdir(join(root, 'dist'))
    await cp(join(packageRoot, 'src/ctxmux-artifact-contract.json'), join(root, 'dist/ctxmux-artifact-contract.json'))
    const binaries = Object.keys(contract.manifests).flatMap(platform =>
      ['ctxmux', 'ctxmuxd'].map(name => join(root, 'vendor/ctxmux', platform, 'bin', name)))
    expect(binaries).toHaveLength(4)
    await Promise.all(binaries.map(path => chmod(path, 0o644)))
    await chmod(join(root, 'bin/ctxmux-bin'), 0o644)
    await execFileAsync(process.execPath, [join(root, 'bin/install-ctxmux.mjs')])
    for (const path of binaries) expect((await stat(path)).mode & 0o777).toBe(0o755)
    const result = await execFileAsync(join(root, 'bin/ctxmuxd'), ['--version'])
    expect(result.stdout).toMatch(/^ctxmuxd 0\.1\.0 \(protocol 21[,)]/u)
  }, 30_000)
})
