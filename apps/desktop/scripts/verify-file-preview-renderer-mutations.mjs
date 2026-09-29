import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'../../..'), arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1), sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const evidence=resolve(root,arg('--output')??'docs/reviews/evidence/local-file-preview-2026-10-04/source-renderer-final')
const base=['run','--root',root,'--maxWorkers=1',...(arg('--config')?['--config',arg('--config')]:[])]
const pane='apps/desktop/src/renderer/src/components/FilePreviewPane.tsx',router='apps/desktop/src/renderer/src/components/FileSurfaceView.tsx',store='apps/desktop/src/renderer/src/store.ts',href='apps/desktop/src/renderer/src/lib/markdown-file-reference.ts'
const paneTest='apps/desktop/test/file-preview-pane.test.tsx',openTest='apps/desktop/test/file-preview-open.test.tsx'
const mutants=[
 ['existing-media-doc-router',router,'if ((format && !format.sourceEditable) || (!doc && binary))','if (!doc && (binary || (format && !format.sourceEditable)))',openTest,'an existing PNG text draft'],
 ['old-media-doc-no-text-save',store,'if (format && !format.sourceEditable) return','if (false) return',openTest,'an existing PNG text draft'],
 ['current-svg-commit-owner',router,'const url = visible && loaded?.content === content ? loaded.url : null','const url = visible && loaded ? loaded.url : null',paneTest,'SVG owner changes'],
 ['nested-markdown-file-base',href,"if (sourcePath && !candidate.startsWith('/') && !candidate.startsWith('~/'))",'if (false)',openTest,'nested Markdown hrefs'],
 ['source-preview-utf8-budget',router,'return result.written > WORKSPACE_FILE_MAX_BYTES || result.read < doc.content.length','return false',paneTest,'current source preview is bounded'],
 ['preview-commit-owner',pane,'const preview = visible && loaded?.owner === key ? loaded : null','const preview = visible ? loaded : null',paneTest,'never renders the previous'],
 ['unknown-binary-readonly-router',router,'if ((format && !format.sourceEditable) || (!doc && binary))','if (format && !format.sourceEditable)',paneTest,'unknown binary has metadata'],
 ['unknown-binary-verdict',store,"if (result.status !== 'read' && result.status !== 'binary')","if (result.status !== 'read')",openTest,'unknown binary returns']
]
await mkdir(evidence,{recursive:true});const records=[]
function run(args){const result=spawnSync(join(root,'node_modules/.bin/vitest'),args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});if(result.error)throw result.error;return{exitCode:result.status,raw:result.stdout+result.stderr,command:['node_modules/.bin/vitest',...args]}}
for(const [name,file,old,mutant,test,pattern] of mutants){const target=join(root,file),original=await readFile(target),text=original.toString('utf8'),start=text.indexOf(old);assert.equal(text.split(old).length,2,'Unique real production block: '+name);const broken=text.replace(old,mutant),block=text.slice(Math.max(0,start-180),start+old.length+180)
 try{await writeFile(target,broken);const result=run([...base,test,'-t',pattern]),log=name+'-red.log';await writeFile(join(evidence,log),result.raw);assert.notEqual(result.exitCode,0);assert.ok(result.raw.includes('AssertionError'),'Behavior assertion RED: '+name);records.push({name,file,sourceSha256:sha(original),mutantSha256:sha(broken),mutation:{old,new:mutant},productionBlock:{text:block,sha256:sha(block)},command:result.command,red:{exitCode:result.exitCode,assertionError:true,log,sha256:sha(result.raw)}});console.log(name+' ASSERTION_RED')}
 finally{await writeFile(target,original);assert.equal(sha(await readFile(target)),sha(original),'Exact restore: '+name)}
}
const green=run([...base,paneTest,openTest,'apps/desktop/test/file-save-store.test.ts','apps/desktop/test/markdown-file-reference.test.tsx','apps/desktop/test/terminal-link-mount.test.tsx']);await writeFile(join(evidence,'restored-green.log'),green.raw);assert.equal(green.exitCode,0,green.raw)
const receipt={schema:'agentmux.file-preview-renderer-mutation.v1',passed:true,mutations:records,restoredGreen:{exitCode:green.exitCode,command:green.command,log:'restored-green.log',sha256:sha(green.raw)},sources:Object.fromEntries(await Promise.all([...new Set(mutants.map(m=>m[1]))].map(async file=>[file,sha(await readFile(join(root,file)))]))),boundary:'Real mounted File surface/Editor/Store production blocks. Each current critical block has raw Assertion RED and exact restored GREEN. Main API and Monaco canvas/worker are controlled boundaries, not native decode/aesthetics proof.'}
await writeFile(join(evidence,'mutation-receipt.json'),JSON.stringify(receipt,null,2));console.log('RESTORED_GREEN')
