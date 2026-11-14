import {resolve,load as sourceLoad} from './prompt-receipt-source-loader.mjs'
export {resolve}
export async function load(url,context,nextLoad){
 const result=await sourceLoad(url,context,nextLoad)
 if(url.endsWith('/agent-message-journal.ts')){
  const anchor=/await rename\(candidate, path\);\s*published = true;/u
  if(!anchor.test(result.source))throw Error('The exact journal publication fault point changed')
  return {...result,source:result.source.replace(anchor,"await rename(candidate, path); published = true; process.stdout.write('published'); await new Promise(() => setInterval(() => {}, 1000));")}
 }
 return result
}
