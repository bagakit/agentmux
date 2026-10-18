import { GUIDE_DOCUMENTS, type GuideId, type GuideSlots } from './generated/agentmux-guides.js'

type Facts<Id extends GuideId> = Readonly<Record<GuideSlots[Id], string>> | ((key: GuideSlots[Id]) => string)

/** Build-owned Markdown projection; no filesystem, network or execution dependency. */
export function guideText<Id extends GuideId>(id: Id,
  ...[facts]: [GuideSlots[NoInfer<Id>]] extends [never] ? [facts?: Facts<Id>] : [facts: Facts<Id>]): string {
  const document = GUIDE_DOCUMENTS[id]
  if (document === undefined) throw new Error('Unknown built-in guide: ' + id)
  return document.replace(/<!-- amux:generated ([a-z][a-z0-9:.-]*) -->/gu, (_marker, key: string) => {
    const fact = typeof facts === 'function' ? facts(key as GuideSlots[Id]) : (facts as Readonly<Record<string, string>> | undefined)?.[key]
    if (fact === undefined) throw new Error('Missing code-owned guide fact: ' + id + ': ' + key)
    return fact
  })
}
