import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { iconReviewConfig } from '../scripts/icon-review/dev.mjs'

it('the live workbench serves current semantic and Mote motion styles from their shared owners', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'icon-review-live-test-'))
  const server = await createServer({ ...iconReviewConfig({ port: 0 }), cacheDir })
  try {
    await server.listen()
    const origin = server.resolvedUrls!.local[0]!
    for (const name of ['semantic-icons', 'mote-identity']) {
      const response = await fetch(new URL(`${name}.css`, origin))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/css')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe(await readFile(`packages/client-ui/src/styles/${name}.css`, 'utf8'))
    }
  } finally { await server.close(); await rm(cacheDir, { recursive: true, force: true }) }
})
