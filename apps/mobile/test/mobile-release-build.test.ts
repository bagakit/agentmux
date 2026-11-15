// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, loadConfigFromFile } from 'vite'
import { expect, it } from 'vitest'

it('publishes the same Mobile Web identity for the same output and stamps the served document', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-mobile-release-')))
  const config = resolve(import.meta.dirname, '../vite.config.ts')
  async function compile(title: string) {
    await writeFile(join(root, 'index.html'), `<!doctype html><html><head><title>${title}</title></head><body></body></html>`)
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, config)
    if (!loaded) throw new Error('Could not load the production Mobile configuration')
    await build({ ...loaded.config, configFile: false, root, logLevel: 'error',
      build: { ...loaded.config.build, rollupOptions: { input: join(root, 'index.html') } } })
    const html = await readFile(join(root, 'dist/index.html'), 'utf8')
    const release = JSON.parse(await readFile(join(root, 'dist/mobile-release.json'), 'utf8'))
    expect(html).toContain(`<meta name="agentmux-mobile-build" content="${release.buildId}">`)
    expect(release.files).toContainEqual({ path: 'index.html', bytes: Buffer.byteLength(html),
      digest: 'sha256:' + createHash('sha256').update(html).digest('hex') })
    return { html, release }
  }
  try {
    const first = await compile('AgentMux')
    expect(await compile('AgentMux')).toEqual(first)
    const changed = await compile('Changed Mobile output')
    expect(changed.release.buildId).not.toBe(first.release.buildId)
    expect(changed.release.digest).not.toBe(first.release.digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
