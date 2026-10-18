import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, join } from 'node:path'
import { createReviewCatalog } from './catalog.mjs'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '../../../..')
const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const out = resolve(root, option('--out') ?? '.local/icon-review/site')
const source = import.meta.dirname
const sha = value => createHash('sha256').update(value).digest('hex')
await fs.mkdir(out, { recursive: true })
const inputs = new Map()
const inputCapture = () => ({name:'icon-review-source-inputs',enforce:'pre',async transform(code,id){
  const path=id.split('?')[0]
  if(path.startsWith(root+'/')&&!path.includes('/node_modules/')) inputs.set(relative(root,path),sha(await fs.readFile(path)))
  return null
}})
const metadataModule = await build({ configFile:false, logLevel:'error', plugins:[inputCapture()], build:{ssr:join(source,'catalog-source.ts'),write:false,minify:false} })
const metadataCode=metadataModule.output.find(item=>item.type==='chunk').code
const metadata = await import('data:text/javascript;base64,' + Buffer.from(metadataCode).toString('base64'))
const catalog = await createReviewCatalog(metadata, { context: option('--context') })
await fs.writeFile(join(out, 'catalog.json'), JSON.stringify(catalog))
for (const file of ['index.html', 'styles.css', 'review-manifest.json']) await fs.copyFile(join(source, file), join(out, file))
for (const name of ['semantic-icons', 'mote-identity']) {
  const style=`packages/client-ui/src/styles/${name}.css`
  await fs.copyFile(join(root,style),join(out,`${name}.css`))
  inputs.set(style,sha(await fs.readFile(join(root,style))))
}
await build({configFile:false,root:source,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},esbuild:{jsxDev:false},plugins:[inputCapture()],build:{emptyOutDir:false,outDir:out,minify:false,lib:{entry:join(source,'app.js'),formats:['es'],fileName:()=> 'app.js'},rollupOptions:{output:{inlineDynamicImports:true}}}})
for(const name of ['index.html','styles.css','review-manifest.json','context-labels.json','catalog.mjs','catalog-source.ts','build.mjs'])inputs.set(relative(root,join(source,name)),sha(await fs.readFile(join(source,name))))
await fs.writeFile(join(out, 'build-inputs.json'), JSON.stringify({ inputs:[...inputs].map(([path,sha256])=>({path,sha256})), publicContract: 'Original catalog, native semantic sprite, theme runtime and validated complete theme file; no product configuration writes.' }, null, 2))
console.log(JSON.stringify({ out: relative(root, out), roles: catalog.roles.length, glyphs: catalog.glyphCount, sourceRefs: catalog.roles.reduce((count, role) => count + role.sources.length, 0), snapshot: catalog.snapshot }))
