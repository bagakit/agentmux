import { vi } from 'vitest'

/** A scroll viewport for happy-dom, which has no layout engine; the production virtualizer stays real. */
export function installFileTreeGeometry(height = 240) {
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!.get!
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!.get!
  const rowHeight = (element: HTMLElement): number => element.classList.contains('tree-create-row')
    ? element.querySelector('.inline-rename-field__error') ? 45 : 25
    : element.querySelector('.inline-rename-field__error') ? 44 : 24
  const prefixHeight = (element: HTMLElement) => 24 + (element.querySelector('.tree-create-row') ? rowHeight(element.querySelector<HTMLElement>('.tree-create-row')!) : 0)
  const heightOf = (element: HTMLElement): number => {
    if (element.classList.contains('file-tree')) return height
    if (element.classList.contains('file-tree__prefix')) return prefixHeight(element)
    if (element.classList.contains('file-tree__virtual-row')) return [...element.children].reduce((total, child) => total + rowHeight(child as HTMLElement), 0)
    if (element.classList.contains('tree-row') || element.classList.contains('tree-create-row')) return rowHeight(element)
    return originalHeight.call(element)
  }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return heightOf(this) })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('file-tree') || this.classList.contains('file-tree__virtual-row') ? 280 : originalWidth.call(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('file-tree__rows') ? prefixHeight(this.previousElementSibling as HTMLElement) : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return heightOf(this) })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('file-tree')) return heightOf(this)
    const rows = this.querySelector<HTMLElement>('.file-tree__rows')
    return (rows ? Number.parseFloat(rows.style.height) : 0) + 24
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const wrapper = this.closest<HTMLElement>('.file-tree__virtual-row')
    const tree = this.closest<HTMLElement>('.file-tree')
    const offset = Number(wrapper?.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0)
    const top = wrapper ? offset + 24 - (tree?.scrollTop ?? 0) : 0
    return new DOMRect(0, top, 280, heightOf(this))
  })
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number, top?: number) {
    this.scrollTop = typeof options === 'number' ? top ?? 0 : options?.top ?? this.scrollTop
    this.dispatchEvent(new Event('scroll'))
  })
}
