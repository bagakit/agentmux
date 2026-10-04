import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { CTXMUX_VERSION } from '../src/ctxmux-run-adapter.js'
import { ctxmuxArtifactSource, ctxmuxManifestSha256, supportedCtxmuxArtifactPlatform } from '../src/runtime-paths.js'

it.each([['darwin', 'arm64'], ['linux', 'x64']])('binds the actual %s/%s artifact through its production platform consumer', (platform, architecture) => {
  const selected = `${platform}-${architecture}`
  const bytes = readFileSync(fileURLToPath(new URL(`../vendor/ctxmux/${selected}/manifest.json`, import.meta.url)))
  const manifest = JSON.parse(bytes.toString())
  expect(supportedCtxmuxArtifactPlatform(platform, architecture)).toBe(selected)
  expect(ctxmuxManifestSha256(platform, architecture)).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(ctxmuxArtifactSource(platform, architecture)).toEqual({ commit: manifest.source.commit, tree: manifest.source.tree })
  expect(CTXMUX_VERSION).toBe(manifest.product.version)
  expect(manifest.product.protocol).toBe(22)
  expect(manifest.sdk.protocol).toBe(22)
  expect(manifest.support).toMatchObject({ platform, architecture })
})
