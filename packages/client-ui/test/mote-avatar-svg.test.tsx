// @vitest-environment node
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'
import { afterAll, expect, it } from 'vitest'
import { MoteFace as FaceDrawing } from '../src/components/MoteFace.js'
import { DEFAULT_MOTE_FACE, MOTE_FACE_PARTS, type MoteFace } from '../src/lib/mote-face.js'
import { moteAvatarSvg } from '../src/lib/mote-avatar-svg.js'
import { SPACE_ICON_CATALOG } from '../src/lib/space-icon-catalog.js'
import { GRAPHITE_THEME, resolveTheme, resolveThemeDocument, type ResolvedTheme } from '../src/theme/catalog.js'
import { iconShapes } from '../src/theme/icon-assets.js'
import { iconSvgMarkup, iconSvgDataUrl } from '../src/theme/icon-sprite.js'

// Parse the finished vector output only. Production generation runs without a Window or Document.
const parser = new Window()
afterAll(async () => { await parser.happyDOM.close() })
function svg(markup: string) {
  const document = new parser.DOMParser().parseFromString(markup, 'image/svg+xml')
  expect(document.querySelector('parsererror')).toBeNull()
  return document.documentElement
}
function drawing(markup: string) {
  const root = svg(markup)
  return [...root.querySelectorAll('path,rect,ellipse,circle,line,polyline,polygon')].map(node => {
    const paint = Object.fromEntries(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'color'].map(name => {
      let owner: Element | null = node as unknown as Element
      while (owner && !owner.hasAttribute(name)) owner = owner.parentElement
      return [name, owner?.getAttribute(name) ?? null]
    }))
    return { tag: node.localName, attributes: [...node.attributes].map(attr => [attr.name, attr.value]), paint }
  })
}
function standalone(markup: string) {
  const root = svg(markup)
  expect(root.querySelector('foreignObject,use,script,image,style,link,a')).toBeNull()
  expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg')
  expect(markup).not.toMatch(/\b(?:href|src|onload|onclick)=|url\(|var\(/u)
  expect(root.querySelectorAll('path,rect,ellipse,circle,line,polyline,polygon').length).toBeGreaterThan(0)
  return root
}

it('serializes the original face drawing without a mounted document or its HTML articulation', () => {
  expect(typeof globalThis.document).toBe('undefined')
  expect(typeof globalThis.window).toBe('undefined')
  const face = Object.freeze({ ...DEFAULT_MOTE_FACE, shape: 'diamond', palette: 'cocoa', eyes: 'wink', brows: 'angled', mouth: 'tooth', accessory: 'horns', nose: 'button', marking: 'freckles' } satisfies MoteFace)
  const original = renderToStaticMarkup(createElement(FaceDrawing, { face })), result = moteAvatarSvg(face)
  expect(original).toContain('<foreignObject')
  expect(original).toContain('mote-face__gesture-head')
  const root = standalone(result)
  expect(root.getAttribute('viewBox')).toBe('0 0 64 64')
  expect(root.getAttribute('width')).toBe('64'); expect(root.getAttribute('height')).toBe('64')
  expect(root.querySelector('svg,div')).toBeNull()
  expect(drawing(result)).toEqual(drawing(original))
  const unreadableTheme = new Proxy({} as ResolvedTheme, { get() { throw Error('Face identity cannot read a theme') } })
  expect(moteAvatarSvg(face, unreadableTheme)).toBe(result)
  expect(moteAvatarSvg(face, resolveTheme({ appAppearance: 'light' }))).toBe(result)
})

it('keeps every non-default saved face part in the same original static and articulated geometry', () => {
  const neutral = drawing(moteAvatarSvg(DEFAULT_MOTE_FACE))
  for (const [part, choices] of Object.entries(MOTE_FACE_PARTS)) {
    for (const value of choices) {
      if (value === DEFAULT_MOTE_FACE[part as keyof MoteFace] || value === 'none') continue
      const face = { ...DEFAULT_MOTE_FACE, [part]: value } as MoteFace
      const result = moteAvatarSvg(face)
      expect(drawing(result), `${part}:${value}`).not.toEqual(neutral)
      expect(drawing(result), `${part}:${value}`).toEqual(drawing(renderToStaticMarkup(createElement(FaceDrawing, { face }))))
      standalone(result)
    }
  }
})

it('uses the catalog’s original semantic icon for every selected identity and the original Mote meaning for default', () => {
  const theme = resolveTheme(), defaultSvg = moteAvatarSvg(null, theme)
  expect(defaultSvg).toBe(iconSvgMarkup(iconShapes('object.mote', theme.value.icons), theme.value.iconStyle, theme.variant.colors.text, theme.variant.colors.surface1))
  standalone(defaultSvg)
  for (const [choice, entry] of Object.entries(SPACE_ICON_CATALOG)) {
    const result = moteAvatarSvg(choice as keyof typeof SPACE_ICON_CATALOG, theme)
    expect(renderToStaticMarkup(createElement(entry.Icon))).toContain(`data-semantic-icon="${entry.semantic}"`)
    expect(result, choice).toBe(iconSvgMarkup(iconShapes(entry.semantic, theme.value.icons), theme.value.iconStyle, theme.variant.colors.text, theme.variant.colors.surface1))
    standalone(result)
  }
})

it('resolves authored icon geometry and solid theme paint without a CSS or sprite dependency', () => {
  const theme = resolveThemeDocument({ ...GRAPHITE_THEME, icons: {
    'object.mote': { kind: 'paths', paths: [{ d: 'M3 4L19 21', fill: 'currentColor' }] },
    'space.research': { kind: 'paths', paths: [{ d: 'M2 9L11 7L20 16' }] }
  }, iconStyle: { strokeWidth: 2.5, linecap: 'butt', linejoin: 'miter' } }, 'light', false)
  const original = moteAvatarSvg(null, theme), selected = moteAvatarSvg('flask', theme)
  expect(original).toContain('d="M3 4L19 21"')
  expect(selected).toContain('d="M2 9L11 7L20 16"')
  for (const result of [original, selected]) {
    const root = standalone(result)
    expect(root.getAttribute('color')).toBe(theme.variant.colors.text)
    expect(root.getAttribute('stroke')).toBe(theme.variant.colors.text)
    expect(root.getAttribute('stroke-width')).toBe('2.5')
    expect(root.getAttribute('stroke-linecap')).toBe('butt')
    expect(root.getAttribute('stroke-linejoin')).toBe('miter')
    expect(root.querySelector('rect')?.getAttribute('fill')).toBe(theme.variant.colors.surface1)
  }
  const native = decodeURIComponent(iconSvgDataUrl(iconShapes('space.research', theme.value.icons), theme.value.iconStyle, theme.variant.colors.text))
  expect(native).toContain(iconSvgMarkup(iconShapes('space.research', theme.value.icons), theme.value.iconStyle, theme.variant.colors.text))
})
