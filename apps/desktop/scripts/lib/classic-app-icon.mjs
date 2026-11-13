import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const backplate = readFileSync(new URL('../../../../packages/client-ui/brand/app-icons/classic-backplate.svg', import.meta.url))

/** Compose the untouched legacy foreground with its single build-owned backplate. */
export function renderClassicAppIcon(source, size = 1024) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <image width="1024" height="1024" href="data:image/svg+xml;base64,${backplate.toString('base64')}"/>
    <image x="56" y="56" width="912" height="912" href="data:image/png;base64,${source.toString('base64')}"/>
  </svg>`
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng()
}
