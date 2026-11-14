import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
// @ts-expect-error Native ESM packaging scripts have no TypeScript declarations.
import { inspectRuntimeApplicationPayload, copyRuntimeFiles } from '../scripts/runtime-application-payload.mjs'

it('loads the declared XML parser from the packaged Main dependency root', async () => {
  const repository = resolve(import.meta.dirname, '../../..')
  const payload = await inspectRuntimeApplicationPayload(repository)
  const temporary = await mkdtemp(join(tmpdir(), 'amux-main-xml-'))
  try {
    const resources = join(temporary, 'AgentMux.app/Contents/Resources/app')
    const main = join(resources, 'out/main')
    await copyRuntimeFiles(payload.copies.filter((item: { target: string }) =>
      item.target.startsWith('node_modules/@xmldom/xmldom/')), resources)
    await mkdir(main, { recursive: true })
    await writeFile(join(resources, 'package.json'), '{"type":"module"}')
    for (let directory = temporary; ; directory = dirname(directory)) {
      await expect(lstat(join(directory, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (directory === dirname(directory)) break
    }
    const entry = join(main, 'consume.mjs')
    await writeFile(entry, `import { DOMParser } from '@xmldom/xmldom';
      const doc = new DOMParser().parseFromString('<manifest><item version="2.1"/></manifest>', 'text/xml');
      console.log(JSON.stringify({ root: doc.documentElement.localName,
        version: doc.getElementsByTagName('item')[0].getAttribute('version'),
        resolved: import.meta.resolve('@xmldom/xmldom') }));`)
    const child = spawnSync(process.execPath, [entry], { cwd: temporary, encoding: 'utf8',
      env: { PATH: process.env.PATH }, timeout: 10000 })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ root: 'manifest', version: '2.1' })
    expect(JSON.parse(child.stdout).resolved).toContain('/Resources/app/node_modules/@xmldom/xmldom/')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
