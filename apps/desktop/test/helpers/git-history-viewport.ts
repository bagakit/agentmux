import { vi } from 'vitest'

/** Supply layout to happy-dom; the real virtualizer, offsets and scroll listeners remain active. */
export function installGitHistoryViewport() {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.classList.contains('git-history-scroll') ? this.clientHeight || 300 : 24
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (options, y) {
    this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? this.scrollTop
    this.scrollLeft = typeof options === 'number' ? options : options?.left ?? this.scrollLeft
    this.dispatchEvent(new Event('scroll'))
  })
}
