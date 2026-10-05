import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { semanticIconComponent, semanticIconHref } from '../src/theme/icons.js'

describe('product-owned children survive the cached semantic component', () => {
  it('keeps the hover explanation and stable size used by a driven Browser tab mark', () => {
    const Icon = semanticIconComponent('object.agent')
    expect(semanticIconComponent('object.agent')).toBe(Icon)
    const html = renderToStaticMarkup(<Icon size={12} className="workbench-tab__driving-mark"><title>Agent driving</title></Icon>)
    expect(html).toContain('<title>Agent driving</title>')
    expect(html).toContain(`href="${semanticIconHref('object.agent')}"`)
    expect(html).toContain('width="12"')
    expect(html).toContain('workbench-tab__driving-mark')
  })
})
