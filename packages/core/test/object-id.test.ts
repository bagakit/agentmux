import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { deriveObjectId, isObjectId, mintObjectId } from '../src/object-id.js'

describe('portable product identity', () => {
  it('keeps entity domains and opaque business keys independent', () => {
    const tab = deriveObjectId('amux.file-tab.v1', JSON.stringify(['workspace', fixturePath("file:name")]))
    const region = deriveObjectId('amux.initial-region.v1', tab)
    expect(isObjectId(tab)).toBe(true)
    expect(isObjectId(region)).toBe(true)
    expect(region).not.toBe(tab)
    expect(deriveObjectId('amux.file-tab.v1', JSON.stringify(['workspace', fixturePath("file:name")]))).toBe(tab)
    expect(deriveObjectId('amux.file-tab.v1', ' a:b')).not.toBe(deriveObjectId('amux.file-tab.v1', 'a:b'))
    expect(deriveObjectId('a', 'b:0:c')).not.toBe(deriveObjectId('b', '0:c'))
    expect(() => deriveObjectId('', 'key')).toThrow(TypeError)
    expect(() => deriveObjectId('a:0:b', 'c')).toThrow(TypeError)
  })

  it('identifies only newly allocated IDs without claiming old IDs or tokens are invalid', () => {
    const id = mintObjectId()
    expect(isObjectId(id)).toBe(true)
    for (const value of [null, 12, {}, '', '11111111111', '1111111111111', '000000000000',
      'OOOOOOOOOOOO', 'IIIIIIIIIIII', 'llllllllllll', '../111111111', 'SCzGtBarRkQBz3b-']) {
      expect(isObjectId(value)).toBe(false)
    }
  })
})
