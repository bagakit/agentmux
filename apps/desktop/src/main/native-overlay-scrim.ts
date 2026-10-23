import type { BrowserBounds } from '../shared/contracts.js'

/** Captured Chrome already includes higher DOM scrims; its contained pages do not. */
export interface NativeScrimExclusion {
  bounds: BrowserBounds
  radius: number
  pages: BrowserBounds[]
}

/** All inputs are window DIP from the native owner, translated once into this SVG. */
export function nativeOverlayScrimScript(
  bounds: BrowserBounds,
  colour: string,
  browsers: readonly BrowserBounds[],
  exclusions: readonly NativeScrimExclusion[]
): string {
  // Nonzero fill paints the union once, including overlapping native pages.
  const path = browsers.flatMap(browser => {
    const x = Math.max(bounds.x, browser.x), y = Math.max(bounds.y, browser.y)
    const right = Math.min(bounds.x + bounds.width, browser.x + browser.width)
    const bottom = Math.min(bounds.y + bounds.height, browser.y + browser.height)
    return right > x && bottom > y ? [`M${x - bounds.x},${y - bounds.y}h${right - x}v${bottom - y}h${x - right}Z`] : []
  }).join('')
  const rectangle = (box: BrowserBounds, fill: string, radius?: number): string =>
    `<rect x="${box.x - bounds.x}" y="${box.y - bounds.y}" width="${box.width}" height="${box.height}"${radius === undefined ? '' : ` rx="${Math.round(radius)}"`} fill="${fill}"/>`
  const clear = [`<rect width="${bounds.width}" height="${bounds.height}" fill="white"/>`]
  for (const exclusion of exclusions) {
    clear.push(rectangle(exclusion.bounds, 'black', exclusion.radius))
    for (const page of exclusion.pages) clear.push(rectangle(page, 'white'))
  }
  // Spell out the entire mask viewport. SVG's default x/y=-10% otherwise clips
  // the final tenth when an explicit width/height replaces its default 120%.
  return `(() => {
    const colour=${JSON.stringify(colour)};
    if(!CSS.supports('color',colour)) throw new Error('Invalid native scrim colour');
    document.querySelector('img').style.display='none';
    const svg=document.querySelector('svg'); svg.style.display='block';
    svg.setAttribute('viewBox',${JSON.stringify(`0 0 ${bounds.width} ${bounds.height}`)});
    const mask=svg.querySelector('mask');
    mask.setAttribute('maskUnits','userSpaceOnUse');
    mask.setAttribute('maskContentUnits','userSpaceOnUse');
    mask.setAttribute('x','0'); mask.setAttribute('y','0');
    mask.setAttribute('width',${JSON.stringify(String(bounds.width))});
    mask.setAttribute('height',${JSON.stringify(String(bounds.height))});
    mask.innerHTML=${JSON.stringify(clear.join(''))};
    const path=svg.querySelector('path'); path.setAttribute('d',${JSON.stringify(path)});
    path.style.fill=colour;
  })()`
}
