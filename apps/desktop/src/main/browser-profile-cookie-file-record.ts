import { z } from 'zod'
import { parseBrowserProfileCookieFileReceipt, parseBrowserProfileCookieFileLocation, parseBrowserProfileCookieFileItem, type BrowserProfileCookieFileReceipt, type BrowserProfileCookieFileLocation, type BrowserProfileCookieFileItem } from '@agentmux/core/control'
const parsed = <T>(parse: (v: unknown) => T) => z.unknown().transform((v,ctx): T => { try { return parse(v) } catch { ctx.addIssue({code:'custom',message:'Original Cookie file operation facts are invalid'}); return z.NEVER } })
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const browserProfileCookieFileRecordSchema = z.object({ receipt:parsed(parseBrowserProfileCookieFileReceipt), items:z.array(parsed(parseBrowserProfileCookieFileItem)),
  approved:z.boolean(), source:parsed(parseBrowserProfileCookieFileLocation).optional(), sourceDigest:digest.optional(), destination:parsed(parseBrowserProfileCookieFileLocation).optional(), outputDigest:digest.optional() }).strict().superRefine((r,ctx)=>{
    const observed={applied:0,skipped:0,rejected:0,unknown:0,notAttempted:0};for(const item of r.items){if(item.status==='not-attempted')observed.notAttempted++;else observed[item.status]++}
    if(Object.keys(observed).some(k=>observed[k as keyof typeof observed]!==r.receipt.counts[k as keyof typeof observed]))ctx.addIssue({code:'custom',message:'Cookie result counts do not match their original item facts'})
    if(r.items.length!==r.receipt.counts.total||r.items.some((v,i)=>v.index!==i)||r.receipt.kind==='import'&&(!r.source||r.destination!==undefined)||r.receipt.kind==='export'&&(!r.destination||r.source!==undefined))ctx.addIssue({code:'custom',message:'Original Cookie file scope or item identities conflict'})
})
export type BrowserProfileCookieFileRecord = z.infer<typeof browserProfileCookieFileRecordSchema>
