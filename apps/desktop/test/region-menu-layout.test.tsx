import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
describe('region menu layout', () => { it('exposes region move actions', async () => { const s = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/RegionContextMenu.tsx'), 'utf8'); expect(s).toContain('swap') }) })
