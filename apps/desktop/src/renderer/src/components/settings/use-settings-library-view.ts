import { useLayoutEffect, useRef, useState } from 'react'

type LibraryView = 'library' | 'editor'

/** Both panes stay mounted. The wide view remembers which side should stay visible when space runs out. */
export function useSettingsLibraryView(active: boolean, initialView: LibraryView = 'library') {
  const [view, setView] = useState(initialView)
  const [narrow, setNarrow] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLElement>(null)
  const pendingFocus = useRef<(() => HTMLElement | null) | null>(null)
  useLayoutEffect(() => {
    const node = host.current
    if (!active || !node) return
    const update = () => {
      const width = node.getBoundingClientRect().width
      setNarrow(width > 0 && width <= 660)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [active])
  useLayoutEffect(() => {
    const target = pendingFocus.current
    pendingFocus.current = null
    if (active) target?.()?.focus()
  })

  function rememberFocus(side: LibraryView) {
    if (!narrow) setView(side)
  }

  function openEditor(fromRow = false) {
    if (fromRow) {
      if (!narrow) return
      pendingFocus.current = () => editor.current
    }
    setView('editor')
  }

  function returnToLibrary(target: () => HTMLElement | null) {
    pendingFocus.current = target
    setView('library')
  }

  return { view, narrow, host, editor, rememberFocus, openEditor, returnToLibrary }
}
