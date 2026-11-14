import { useLayoutEffect, useRef } from 'react'

/** A decorative background for the current direct child of a positioned container. */
export function SelectionIndicator() {
  const ref = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const indicator = ref.current
    const host = indicator?.parentElement
    const view = indicator?.ownerDocument.defaultView
    if (!indicator || !host || !view) return
    let frame: number | null = null

    const update = () => {
      const current = host.querySelector<HTMLElement>(':scope > [aria-current]:not([aria-current="false"]):not([aria-current=""])')
      const width = current?.offsetWidth ?? 0, height = current?.offsetHeight ?? 0
      if (!current || !width || !height) {
        indicator.hidden = true
        delete indicator.dataset.selectionMotion
        if (frame !== null) { view.cancelAnimationFrame(frame); frame = null }
        return
      }
      indicator.style.transform = `translate(${current.offsetLeft}px, ${current.offsetTop}px)`
      indicator.style.width = `${width}px`
      indicator.style.height = `${height}px`
      if (indicator.hidden) {
        indicator.hidden = false
        frame = view.requestAnimationFrame(() => { indicator.dataset.selectionMotion = 'true'; frame = null })
      }
    }

    const resize = new view.ResizeObserver(update)
    const observeLayout = () => {
      resize.disconnect()
      resize.observe(host)
      for (const child of host.children) if (child !== indicator) resize.observe(child)
      update()
    }
    const children = new view.MutationObserver(records => {
      if (records.some(record => record.target === host)) observeLayout()
      else if (records.some(record => record.target.parentNode === host && record.type === 'attributes')) update()
    })
    observeLayout()
    children.observe(host, { childList: true, attributes: true, attributeFilter: ['aria-current'], subtree: true })
    return () => {
      resize.disconnect()
      children.disconnect()
      if (frame !== null) view.cancelAnimationFrame(frame)
    }
  }, [])

  return <span ref={ref} className="selection-indicator" aria-hidden="true" hidden />
}
