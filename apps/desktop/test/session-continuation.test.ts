import { describe, expect, it } from 'vitest'
import { buildContinuationPrompt } from '../src/renderer/src/lib/session-continuation.js'
const m=(id:string,content:string)=>({id,content,source:'native-hook',kind:'assistant_message',status:'complete',agentSessionId:'s',createdAt:1,updatedAt:1,title:''} as never)
describe('session continuation',()=>{it('includes only selected transcript prefix',()=>{const p=buildContinuationPrompt([m('a','one'),m('b','two'),m('c','future')],'b');expect(p).toContain('one');expect(p).toContain('two');expect(p).not.toContain('future')});it('rejects unknown cutoff',()=>expect(()=>buildContinuationPrompt([m('a','one')],'x')).toThrow('unavailable'))})
