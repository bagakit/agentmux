import { Resvg } from '@resvg/resvg-js'

/** Native macOS bitmaps include their own silhouette; Dock does not mask a PNG. */
export function renderMacOSAppIcon(source, size = 1024) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs><clipPath id="macos-icon"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
    <image x="100" y="100" width="824" height="824" clip-path="url(#macos-icon)" href="data:image/png;base64,${source.toString('base64')}"/>
  </svg>`
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng()
}
