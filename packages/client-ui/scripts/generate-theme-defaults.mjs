import { readFile, writeFile } from 'node:fs/promises'
import { resolveTheme, themeCssVariables } from '../dist/theme/index.js'
const target = new URL('../src/styles/theme-defaults.css', import.meta.url)
const block = (selector, mode) => `${selector} {\n  color-scheme: ${mode};\n${Object.entries(themeCssVariables(resolveTheme({ appAppearance: mode }))).map(([key, value]) => `  ${key}: ${value};`).join('\n')}\n}\n`
const css = '/* Generated from the shared theme catalog. Run client-ui generate:theme; do not edit. */\n' + block(':root', 'dark') + '\n' + block(':root[data-appearance="light"]', 'light')
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== css) throw new Error('Default CSS projection differs from the theme catalog. Run client-ui generate:theme.')
} else await writeFile(target, css)
