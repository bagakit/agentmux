import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, relative, join, extname, basename } from 'node:path'
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
const { getSemanticIconCatalog, ICON_GLYPHS } = await import('data:text/javascript;base64,' + Buffer.from(metadataCode).toString('base64'))
const metadata = getSemanticIconCatalog()
if (!metadata.icons.length || !metadata.glyphs.length) throw new Error('The shared icon catalog must be nonempty.')
const prior = option('--context') ? JSON.parse(await fs.readFile(resolve(root, option('--context')), 'utf8')) : { roles: [] }
const annotations = new Map(prior.roles.map(role => [role.id, role]))
const contextNames = JSON.parse(await fs.readFile(join(source, 'context-labels.json'), 'utf8'))
const categoryLabels = { all: '全部用途', status: '状态与反馈', action: '通用操作', object: '空间与对象', navigation: '页面与历史导航', layout: '布局与分割', editor: '编辑器', file: '文件类型', conversation: '对话与输入', drawing: '截图与标注', space: '空间外观', toolkit: 'Toolkit 外观', control: '原生控件', avatar: '头像与徽章', appearance: '外观设置', git: 'Git 与变更', note: '笔记与引用' }
const family = { 'status.working': '正在工作／产出', 'status.streaming': '内容正在流入', 'status.browser-running': '浏览器正在执行操作', 'object.activity': '历史工作记录' }
const ownerPath = 'packages/client-ui/src/theme/icon-catalog.ts'
const owner = await fs.readFile(join(root, ownerPath), 'utf8')
const references = new Map(metadata.icons.map(icon => [icon.id, []]))
const rolePattern = new RegExp(`(?<![\\w.-])(?:${metadata.icons.map(icon => icon.id.replaceAll('.', '\\.')).join('|')})(?![\\w.-])`, 'g')
async function scan(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name), path = relative(root, file).replaceAll('\\', '/')
    if (entry.isDirectory()) { if (entry.name !== 'theme') await scan(file); continue }
    if (!['.ts', '.tsx', '.css'].includes(extname(file)) || path.endsWith('/index.ts')) continue
    const text = await fs.readFile(file, 'utf8'), seen = new Set()
    for (const match of text.matchAll(rolePattern)) {
      if (seen.has(match[0])) continue
      seen.add(match[0]); const line = text.slice(0, match.index).split('\n').length
      references.get(match[0]).push({ file: path, line, kind: 'literal', excerpt: text.split('\n')[line - 1].trim().slice(0, 220) })
    }
    for (const match of text.matchAll(/`(status\.(?:toolkit-|observation-|prompt-)?|conversation\.reference-)\$\{/g)) {
      const line = text.slice(0, match.index).split('\n').length
      for (const icon of metadata.icons.filter(icon => icon.id.startsWith(match[1]))) if (!seen.has(icon.id)) {
        references.get(icon.id).push({ file: path, line, kind: 'dynamic', excerpt: text.split('\n')[line - 1].trim().slice(0, 220) })
      }
    }
  }
}
for (const directory of ['packages/client-ui/src', 'apps/desktop/src/renderer/src', 'apps/mobile/src']) await scan(join(root, directory))
// Native CSS consumers have masks instead of literal semantic IDs. These are source references only.
const nativeSource=await fs.readFile(join(root,'packages/client-ui/src/theme/icon-sprite.ts'),'utf8')
for(const match of nativeSource.matchAll(/'(--native-[^']+)': '([^']+)'/g)) {
  if(!references.has(match[2]))continue
  for(const directory of ['packages/client-ui/src/styles','apps/desktop/src/renderer/src/styles']) {
    for(const name of await fs.readdir(join(root,directory))) {
      if(!name.endsWith('.css'))continue
      const path=join(directory,name),text=await fs.readFile(join(root,path),'utf8'),position=text.indexOf(match[1])
      if(position<0)continue
      const line=text.slice(0,position).split('\n').length
      references.get(match[2]).push({file:path,line,kind:'native',excerpt:text.split('\n')[line-1].trim().slice(0,220)})
    }
  }
}
const roles = metadata.icons.map(icon => {
  const position = owner.indexOf(`'${icon.id}'`), sources = references.get(icon.id)
  const confirmedRefs=sources.filter(ref=>ref.kind!=='dynamic')
  const contexts = [...new Set(confirmedRefs.map(ref => contextNames[basename(ref.file, extname(ref.file))]).filter(Boolean))]
  return { id: icon.id, label: icon.label, description: icon.description, glyph: icon.defaultGlyph, category: icon.groupId,
    meaning: family[icon.id] ?? annotations.get(icon.id)?.meaning ?? icon.label,
    feature: contexts.length ? contexts.slice(0, 3).join('、') : confirmedRefs.length ? metadata.groups.find(group => group.id === icon.groupId).description : sources.length ? '动态前缀候选 · 需核对具体语义' : '目录登记 · 本次静态扫描未发现具体消费',
    definition: { file: ownerPath, line: owner.slice(0, position).split('\n').length }, sources,
    provenance: { geometry: 'shared_owner', meaning: 'review_annotation', feature: confirmedRefs.length ? 'source_scan' : sources.length ? 'dynamic_candidates' : 'catalog_only' } }
})
const sourceFiles = {}
for (const path of [ownerPath, 'packages/client-ui/src/theme/icon-glyphs.ts', 'packages/client-ui/src/theme/icon-catalog-metadata.ts']) sourceFiles[path] = sha(await fs.readFile(join(root, path)))
const customGlyphs = ['status-dot', 'redaction-block', 'resize-corner', 'workflow-progress', 'mote-mark', 'work-writing', 'content-stream', 'browser-executing', 'work-history']
const catalog = { format: 'agentmux.icon-catalog.v1', pageId: 'agentmux-icon-matrix', snapshot: sha(JSON.stringify(sourceFiles)),
  generatedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  categories: [{ id: 'all', label: categoryLabels.all }, ...metadata.groups.map(group => ({ id: group.id, label: categoryLabels[group.id] ?? group.label }))],
  roles, customGlyphs, sourceFiles, glyphCount: Object.keys(ICON_GLYPHS).length,
  scanScope:{roots:['packages/client-ui/src','apps/desktop/src/renderer/src','apps/mobile/src'],extensions:['.ts','.tsx','.css'],excluded:['theme directory in ordinary scan','index.ts'],nativeSource:'packages/client-ui/src/theme/icon-sprite.ts',dynamic:'Prefix candidates only; exact targets are not resolved and do not prove actual consumer coverage.'} }
await fs.writeFile(join(out, 'catalog.json'), JSON.stringify(catalog))
for (const file of ['index.html', 'styles.css', 'review-manifest.json']) await fs.copyFile(join(source, file), join(out, file))
await build({configFile:false,root:source,logLevel:'error',plugins:[inputCapture()],build:{emptyOutDir:false,outDir:out,minify:false,lib:{entry:join(source,'app.js'),formats:['es'],fileName:()=> 'app.js'},rollupOptions:{output:{inlineDynamicImports:true}}}})
for(const name of ['index.html','styles.css','review-manifest.json','context-labels.json','build.mjs'])inputs.set(relative(root,join(source,name)),sha(await fs.readFile(join(source,name))))
await fs.writeFile(join(out, 'build-inputs.json'), JSON.stringify({ inputs:[...inputs].map(([path,sha256])=>({path,sha256})), publicContract: 'Original catalog, native semantic sprite, theme runtime and validated complete theme file; no product configuration writes.' }, null, 2))
console.log(JSON.stringify({ out: relative(root, out), roles: roles.length, glyphs: catalog.glyphCount, sourceRefs: roles.reduce((count, role) => count + role.sources.length, 0), snapshot: catalog.snapshot }))
