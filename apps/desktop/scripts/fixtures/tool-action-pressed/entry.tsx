import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GRAPHITE_THEME, mountThemeRuntime, updateObservedTheme } from '@agentmux/client-ui/theme'
import type { BrowserScreenshotCapture } from '../../../src/shared/contracts'
import { ScreenshotEditor } from '../../../src/renderer/src/components/browser-screenshot/ScreenshotEditor'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import '../../../src/renderer/src/styles/index.css'

const canvas = document.createElement('canvas')
canvas.width = 1024
canvas.height = 576
const paint = canvas.getContext('2d')!
paint.fillStyle = '#f2eee8'
paint.fillRect(0, 0, canvas.width, canvas.height)
paint.fillStyle = '#323a3b'
paint.font = '36px sans-serif'
paint.fillText('A small field study', 76, 96)
paint.fillStyle = '#516f68'
paint.font = '20px sans-serif'
paint.fillText('Route notes and observations', 76, 145)
paint.strokeStyle = '#80988a'
paint.lineWidth = 8
paint.beginPath()
paint.moveTo(112, 413)
paint.lineTo(303, 303)
paint.lineTo(474, 347)
paint.lineTo(601, 219)
paint.lineTo(805, 288)
paint.stroke()
for (const [x,y] of [[112,413],[303,303],[474,347],[601,219],[805,288]] as const) {
  paint.beginPath()
  paint.arc(x, y, 14, 0, Math.PI * 2)
  paint.fill()
}
const dataUrl = canvas.toDataURL('image/png')
const capture: BrowserScreenshotCapture = {
  browserId: 'original-browser', navigationId: 'original-page',
  image: { mimeType: 'image/png', dataUrl, width: canvas.width, height: canvas.height, byteLength: atob(dataUrl.split(',')[1]!).length },
  source: { url: null, title: 'Field notes', viewport: { width: canvas.width, height: canvas.height, deviceScaleFactor: 1 }, viewportWarning: null }
}
let edits = 0
mountThemeRuntime(window, { appAppearance: 'dark' })
function Workface() {
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false)
  Object.assign(window, { toolActionProof: {
    busy: setBusy,
    appearance: (tone: 'dark' | 'light') => updateObservedTheme(GRAPHITE_THEME, tone),
    observed: () => ({ browserId: capture.browserId, navigationId: capture.navigationId, edits })
  } })
  return <DesktopClientUiProvider><main className="browser-surface" style={{ width: '100%', height: '100%', position: 'relative' }}>
    {open ? <ScreenshotEditor capture={capture} workspaceId="original-workspace" busy={busy}
      onComplete={() => {}} onCancel={() => setOpen(false)} onEdited={() => edits++} />
      : <button type="button" onClick={() => setOpen(true)}>Open screenshot markup</button>}
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Workface />)
