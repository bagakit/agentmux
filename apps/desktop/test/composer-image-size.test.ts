import { expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles'

it('fits pasted thumbnails to one text line with proportional width', () => {
  const rules = [...allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector!.trim() === '.composer-image .md-conversation-image__thumb')
  expect(rules).toHaveLength(1)
  const declarations = rules[0]![2]!
  expect(declarations).toMatch(/width:\s*auto;/)
  expect(declarations).toMatch(/height:\s*auto;/)
  expect(declarations).toMatch(/max-height:\s*1lh;/)
  expect(declarations).toMatch(/object-fit:\s*contain;/)
})
