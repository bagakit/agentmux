import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFile(
  fileURLToPath(new URL('../src/renderer/src/components/GlobalBoardSurface.tsx', import.meta.url)),
  'utf8'
)

/**
 * 切出 `createDemandCard` 的函数体，**两端都证明自己找到了**。
 *
 * 本仓记过这个形状：`s.slice(s.indexOf('<Foo'), …)` 的起锚点一旦不在源码里，`indexOf` 返回 -1，
 * 切出来是空串或整份文件，之后每一条断言要么恒真要么恒假，而 tsc 干净、测试全绿。所以这里
 * 起止都 `expect(...).toBeGreaterThan(-1)`，切完再证明切到的确实是那一段。
 */
async function createDemandCardBody(): Promise<string> {
  const source = await SOURCE
  const start = source.indexOf('function createDemandCard(): void {')
  expect(start, '找不到 createDemandCard——它被改名或删掉了，下面的断言会失去意义').toBeGreaterThan(-1)
  const end = source.indexOf('\n  }\n', start)
  expect(end, '找不到 createDemandCard 的结尾').toBeGreaterThan(start)
  const body = source.slice(start, end)
  expect(body).toContain('createDemand(')
  return body
}

describe('global Demand Board production surface', () => {
  it('contains the Demand-first card, routing filters, and fixed detail workspace', async () => {
    const source = await SOURCE
    for (const anchor of ['DemandCard', 'DemandWorkspace', 'routingFilter', 'plannedStartAt', 'AgentTopologySummary', 'requestPmoTeamsTopicFloatingOpen']) expect(source).toContain(anchor)
  })

  it('persists an explicit New Demand before opening PMO with that Demand identity', async () => {
    const body = await createDemandCardBody()
    // 顺序是这条判据的全部：先落一条 backlog Demand，再拿它的 id 去开 PMO。反过来（先开 PMO
    // 再补建）会让 Topic 收到一个还不存在的身份，于是它自己又建一条——两条 Demand 指同一件事。
    const create = body.indexOf('const demandId = createDemand(')
    const open = body.indexOf('openDemandPmo(demandId, prompt)', create)
    expect(create).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(create)
    expect(body.slice(create, open)).toContain("status: 'backlog'")
    // Demand 的身份必须真的进到 prompt 里，否则 Topic 无从知道自己在谈哪一条。
    expect(body).toContain('Demand ${demandId}')
    // Topic 必须被告知「这条已经建好了」——不然它会照自己的默认流程再建一条。
    //
    // 这里判的是**这句话在不在 prompt 里**，不是它逐字长什么样：上一版钉死了
    // 「从 Board 的 New Demand 入口接到已创建的 Demand」整句，而入口文案后来从「Board 的
    // New Demand」改成了「Work 的 New request」，于是守卫红了——行为一步没变，红的是文案。
    // 承重的是「已创建」与「不要重复创建」这两个意思，按意思钉。
    const prompt = body.slice(body.indexOf('const prompt = '), open)
    expect(prompt).toContain('已创建的 Demand')
    expect(prompt).toContain('不要重复创建 Demand')
  })
})
