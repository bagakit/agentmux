import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const files = [
  'src/main/ipc.ts',
  'src/preload/index.ts',
  'src/shared/contracts.ts',
  'src/renderer/src/lib/api.ts',
  'src/renderer/src/store.ts'
].map((relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'))

it('wires the filesystem Demand store through Main, preload, typed API, and startup hydration', () => {
  const source = files.join('\n')
  expect(files.length).toBeGreaterThan(0)
  expect(source).toContain("openDemandStore({ root: join(app.getPath('userData'), 'demands') })")
  for (const route of ['demands:list', 'demands:create', 'demands:update', 'demands:delete', 'demands:linkSession', 'demands:unlinkSession', 'demands:activity', 'demands:decision']) {
    expect(source).toContain(route)
  }
  expect(source).toContain('api.demands.list()')
  expect(source).toContain('demandRecordFromFilesystem')
})

it('keeps the existing projection when the filesystem read fails', () => {
  const source = files.find((value) => value.includes('Demand filesystem snapshot'))
  expect(source).toBeDefined()
  expect(source).toContain('saved Board Demand projection remains visible')
})
