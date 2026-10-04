import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..'), desktop = createRequire(join(root,'apps/desktop/package.json'))
const { build } = createRequire(desktop.resolve('vite'))('esbuild')
const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amx-data-cpu-")), entry = join(temporary,'entry.ts'), readers = join(temporary,'readers.cjs')
const rows = []
try {
  await writeFile(entry, `export {readYamlPreview,readTomlPreview} from ${JSON.stringify(join(root,'apps/desktop/src/renderer/src/lib/file-formats/data-config.ts'))};export {readJsonLines} from ${JSON.stringify(join(root,'apps/desktop/src/renderer/src/lib/file-formats/data-jsonl.ts'))};`)
  await symlink(join(root,'apps/desktop/node_modules'),join(temporary,'node_modules'),'dir')
  await build({ entryPoints: [entry], outfile: readers, bundle: true, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'error' })
  for (const kind of ['yaml-keys','yaml-documents','toml-keys','jsonl-records','jsonl-one-object']) {
    const lines = []; let bytes = 0, index = 0
    while (true) {
      const line = kind === 'yaml-keys' ? `key${index}: value for this entry\n` : kind === 'yaml-documents' ? `---\nkey${index}: value for this entry\n`
        : kind === 'toml-keys' ? `key${index} = "value for this entry"\n` : kind === 'jsonl-records' ? JSON.stringify({id:index,value:'value for this entry'})+'\n' : `"key${index}":"value for this entry",`
      if (bytes + line.length > 1024*1024 - 2) break
      lines.push(line); bytes += line.length; index++
    }
    let source = lines.join(''); if (kind === 'jsonl-one-object') source = '{'+source.slice(0,-1)+'}'
    const input = join(temporary,'input.txt'), runner = join(temporary,'run.mjs')
    await writeFile(input,source)
    const parser = kind.startsWith('yaml') ? 'readYamlPreview' : kind.startsWith('toml') ? 'readTomlPreview' : 'readJsonLines'
    await writeFile(runner,`import {readFile} from 'node:fs/promises';import readers from ${JSON.stringify(readers)};const parse=readers.${parser},source=await readFile(${JSON.stringify(input)},'utf8'),start=performance.now(),result=parse(source);console.log(JSON.stringify({ms:performance.now()-start,status:result.status,records:result.records?.length,diagnostics:result.diagnostics?.length,truncated:result.truncated}));`)
    const result = spawnSync(process.execPath,[runner],{encoding:'utf8',timeout:12_000,maxBuffer:1024*1024})
    const row = {kind,bytes:source.length,entries:index,...(result.status === 0 ? JSON.parse(result.stdout) : {exit:result.status,signal:result.signal,error:result.error?.message,stderr:result.stderr.slice(-1000)})}
    rows.push(row); console.log(JSON.stringify(row))
  }
  const evidence = join(root,'.bagakit/editor-format-implementation/evidence/structured-parser-cpu-node.json')
  await mkdir(resolve(evidence,'..'),{recursive:true}); await writeFile(evidence,JSON.stringify({date:new Date().toISOString(),node:process.version,boundary:'Actual bundled production pure readers, independent Node process per near-1MiB fixture. Parse and bounded model conversion included; import time excluded. No Chromium DOM claim.',rows},null,2))
} finally { await rm(temporary,{recursive:true,force:true}) }
