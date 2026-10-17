import { expect, it } from 'vitest'
import { notificationPreview } from '../src/renderer/src/lib/notification-preview'

it('preserves the distinct whitespace, code-point and ellipsis semantics of notification titles and announcements', () => {
  const whitespace = ['', ' ', '\t\n', '\u00a0\ufeff', '\u2028\u2029', ' '.repeat(1024)]
  const bodies = ['', 'a', 'a'.repeat(99), 'a'.repeat(100), 'a'.repeat(101), 'a'.repeat(99) + ' b',
    '😀'.repeat(100), '😀'.repeat(101), 'a'.repeat(99) + '😀', '👨‍👩‍👧'.repeat(30), '\ud800x\udc00']
  for (const before of whitespace) for (const body of bodies) for (const after of whitespace) {
    const text = before + body + after, collapsed = text.replace(/\s+/g, ' ')
    const title = Array.from(collapsed.trim())
    expect(notificationPreview(text, 'title')).toBe(title.length > 100 ? `${title.slice(0, 100).join('')}…` : title.join(''))
    expect(notificationPreview(text, 'announcement')).toBe(Array.from(collapsed).slice(0, 100).join(''))
  }
  expect(notificationPreview('x'.repeat(100) + ' '.repeat(1024), 'title')).toBe('x'.repeat(100))
  expect(notificationPreview('x'.repeat(99) + ' b', 'title')).toBe('x'.repeat(99) + ' …')
})
