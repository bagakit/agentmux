import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const desktop = resolve(import.meta.dirname, '..')

it('bundles the Main image contract without requiring client-ui in the installed app', async () => {
  const output = await mkdtemp(join(tmpdir(), 'amx-main-bundle-'))
  try {
    await run(process.execPath, ['--input-type=module', '-e', `
      import { resolveConfig } from 'electron-vite'
      import { build } from 'vite'
      const { config } = await resolveConfig({configFile: './electron.vite.config.ts'}, 'build')
      await build({
        ...config.main,
        configFile: false,
        build: {...config.main.build, outDir: ${JSON.stringify(output)}}
      })
    `], { cwd: desktop, maxBuffer: 1024 * 1024 })
    const bundle = await readFile(join(output, 'index.js'), 'utf8')
    // Inspect the actual entry build; an empty artifact or empty import scan cannot pass.
    expect(bundle.length).toBeGreaterThan(10_000)
    const imports = [...bundle.matchAll(/^import\s.+?\sfrom\s["']([^"']+)["'];/gm)].map(match => match[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports).toContain('electron')
    expect(imports).toContain('@agentmux/core')
    expect(imports.filter(name => name.startsWith('@agentmux/client-ui'))).toEqual([])
    expect(bundle).toContain('image/png')
    expect(bundle).toContain('PASTED_IMAGE_MAX_BYTES')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
