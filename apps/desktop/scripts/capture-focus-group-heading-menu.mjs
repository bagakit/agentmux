// One explicit entry and reuse contract for the full current Collection/menu candidate.
if (!process.argv.includes('--heading-menus')) process.argv.push('--heading-menus')
await import('./capture-focus-collection-layout.mjs')
