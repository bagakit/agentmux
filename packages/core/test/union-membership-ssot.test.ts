import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { isAgentMuxControlOperation, type AgentMuxControlRequest } from '../src/control.js'
import { parseAgentMuxControlRequest } from '../src/control-host.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'
import {
  isPermissionOptionKind,
  isPromptDeliveryDegradedReason,
  type AgentMuxStoredAgentSession,
  type PermissionOptionKind,
  type PromptDeliveryDegradedReason
} from '../src/types.js'

// ---------------------------------------------------------------------------
// 三个联合的「这个值是不是合法成员」只许有一处声明。
//
// 由来（task #711）：`PermissionOptionKind`、`PromptDeliveryDegradedReason`、
// `AgentMuxControlRequest['operation']` 三条联合的入站校验各自被手抄成了第二份声明——一个裸数组、
// 一条 `!==` 链、一份十二个串的元组——而手抄只强制 **⊆**（列出的每个串都是真成员），对 **⊇** 完全失明。
// 往联合里加一个成员而忘了往那份手抄里加，后果不是"新成员不生效"，是**每一条带新成员的合法磁盘记录/
// 合法入站请求被拒掉**（`INVALID_AGENT_SESSION_STORE` / `INVALID_CONTROL_REQUEST`），fail-closed 的
// 数据丢失，且 tsc 全程沉默。而"加成员"正是常见方向。
//
// 修法是让每条联合的拥有方导出一个收窄谓词，校验方只问那个谓词——不再另写清单，也不再 `as` 一次
// （那个 cast 是同一件事的第二个声明点：校验用的清单与断言成的类型会各自漂移）。
//
// **为什么必须有结构判据、光靠行为测试不够**：一份**完整**的手抄与派生**行为完全相同**，所以任何
// 行为断言都分辨不出二者（agent-session-store.ts 里 readiness-source 那处投影的注释亲口写过这句）。
// 于是这里分三层，各杀各的：
//   A 行为·谓词：谓词接受每个成员、拒绝非成员。杀"谓词内部清单少了一个"与"谓词恒真"。
//   B 行为·校验点：真正的校验函数（不是谓词）放行每个成员、拒掉非成员。杀"校验点那道闸整段删掉"
//     与"校验点自己抄了一份**短**清单"。三条联合的 B 层都在本文件（见下面那一段注释：store 那两条
//     的 B 层原本被我推给了 agent-session-store.test.ts，而那边**没有**一条带 `allow-always` 的夹具，
//     于是丢掉两个 -always 的手抄实测存活）。
//   C 结构：拥有方之外，**没有任何一处枚举出整条联合**。
//
// C 层的判据是「完整性」而不是「某个禁止形状不在场」（本仓 forbidden-list 家族的守卫既漏又误伤）：
// 一份**能今天正确工作**的手抄membership 判定必须列全所有成员，而列全正是"它成了第二个声明点"这件事
// 本身；只列出真子集的表达式按构造就是**分类**判定（"这两种算拒绝"、"这三种走同一支解析"），它们不承诺
// 覆盖联合，加成员时也不会因为没被提到而拒掉数据。于是不需要任何豁免清单——真实存在的三处子集判定
// （acp-adapter 的"算不算拒绝"、control-host 的两处按操作分组解析）由这条判据本身放过，不靠人手写例外。
//
// **本守卫看不见什么**（务必知道）：
//   1. 一份**不完整**的手抄能逃过 C 层——但那正好是今天就错的行为缺陷，由 A/B 层抓。两层互补，
//      任一层单独都不够，这是刻意的分工，不是重复。
//   2. 只认三种枚举形状：数组/Set 字面量、同一操作数上的 `=== 'x' || === 'y'` 链、以及它的 De Morgan
//      取反形 `!== 'x' && !== 'y'`。用 switch 的穷举 case、或把成员串拼出来的写法看不见。（switch 的每个
//      case 是独立分支，不构成一次 membership 判定；拼串的写法本仓尚未出现，出现时该由这条判据升级来接。）
//      **这条曾经只认两种形状，而漏掉的第三种正是本仓真实出现过的那一份**：#711 从
//      `terminalPromptDelivery` 删掉的手抄就是取反链，把它原样改回去（一行）在四个 suite 75/75 +
//      tsc exit 0 下**实测存活**。两种极性是同一个判定的两种写法，判据必须对称，否则守的只是拼法的一半。
//      顺带的一条经验：这里此前把 switch 和拼串列为盲点、却没列出真正在用的取反形，说明"申报盲点"这件事
//      本身要按**语言里等价的写法**穷举，不能按"我想得到的花招"列举。
//   3. 只扫 src/。别的包里的手抄不在雷达上——desktop 侧的 permission kind 只作渲染用途，不做
//      入站校验，那边的判据归那边。
//   4. 成员集合由**本文件手写**、由 tsc 钉住（见下面三个 Record）。这是刻意的外部锚点：若从被测的
//      SSOT 自己派生，判据会跟着变异一起漂移而恒真（expected-value-must-not-derive-from-mutation-target）。
//      packages/core 的 tsconfig 的 include 含 `test/**/*.ts`（apps/desktop 的**不含**，见 #626/#676），
//      所以这里的编译期约束是真的被执行的，不是死代码——M5 实测在 `DEGRADED_REASON_ANCHOR` 那个
//      Record 上报出 `error TS2353`，锚点确实在编译。（这里刻意不写行号：本条此前写着 `(75,3)`，
//      而真实位置早已随文件编辑漂走，审计把它当成一处不实。锚点用符号名，不用坐标。）
//
// **三层分工是实测出来的，不是推理出来的。** 九个变异，各在它自己那层红（基线
// `Test Files 4 passed (4) / Tests 75 passed (75)`，四个 suite 是本文件 + control-host + control-export-reachability
// + agent-session-store）：
//   M1 store 的闸换成**完整**四元手抄  → 只有 C 层红（行为完全相同，B 层按设计分辨不出）
//   M2 store 的闸换成**不完整**手抄（丢两个 -always）→ 只有 B 层「四种权限答复方向」红
//        ※ 这一个在补 B 层之前**存活**：`Test Files 2 passed (2) / Tests 49 passed (49)`。
//          原因是我当时把 store 那两条的 B 层推给了 agent-session-store.test.ts，而那边没有
//          任何夹具带 `allow-always`。C 层按设计放过真子集，于是两层都没人管。
//   M3 store 的整道闸删掉                → B 层「非答复方向被响亮拒掉」红
//   M4 `isPermissionOptionKind` 改成恒 true → A 层 + B 层各红一条
//   M5 从 `PROMPT_DELIVERY_DEGRADED_REASONS` 删一个成员（⊇ 方向，真正的数据丢失形状）
//                                          → tsc 报 TS2322+TS2353，且 A/B/C 三层与 store 的既有断言共 4 条红
//   M6 control-host :138 换成**不完整**手抄 → B 层「十二个操作全部越过 membership 闸」红
//   M7 control-host :138 换成**完整**手抄   → 只有 C 层红
//   M8 `OPERATION_BUDGET` 注解放宽成 `Record<string, …>` → control-host.test.ts 的注解判据红
//   M9 从 `OPERATION_BUDGET` 删一个键        → tsc 报 TS2741，且 A/B 层各红
// 结论：C 抓「完整的手抄」（今天行为正确、下一次加成员时炸），A/B 抓「不完整的手抄 / 整段闸被删 /
// 谓词退化」（今天就错）。缺任何一层都有一族变异存活，这是分工不是重复。
// ---------------------------------------------------------------------------

/**
 * 三个联合的成员全集——**本文件手写的锚点**，由 tsc 强制与联合逐字相等：
 * 少一个键报 TS2741，多一个（或拼错）报 TS2353。往联合加成员时这里必须跟着加，而"跟着加"这件事
 * 是编译期强制的，不是靠记性。
 *
 * 顺序不承重（下面每处都只做成员判定）。
 */
const PERMISSION_KIND_ANCHOR: Record<PermissionOptionKind, true> = {
  'allow-once': true,
  'allow-always': true,
  'reject-once': true,
  'reject-always': true
}
const DEGRADED_REASON_ANCHOR: Record<PromptDeliveryDegradedReason, true> = {
  'screen-evidence-gap': true,
  'prompt-render-timeout': true,
  'screen-evidence-replaced': true
}
/** 同一份锚点在 control-host.test.ts 里也有一处（那边用它钉「每个操作都被显式定过档」）。两处都被 tsc 钉住，故不会互相漂移。 */
const CONTROL_OPERATION_ANCHOR: Record<AgentMuxControlRequest['operation'], true> = {
  'inspect.tab': true,
  'inspect.region': true,
  'open.agent': true,
  'open.terminal': true,
  'open.browser': true,
  send: true,
  focus: true,
  arrange: true,
  'promote.region': true,
  'list.agents': true,
  interrupt: true,
  resume: true,
  stop: true
}

const PERMISSION_KIND_MEMBERS = Object.keys(PERMISSION_KIND_ANCHOR) as readonly PermissionOptionKind[]
const DEGRADED_REASON_MEMBERS = Object.keys(DEGRADED_REASON_ANCHOR) as readonly PromptDeliveryDegradedReason[]
const CONTROL_OPERATION_MEMBERS = Object.keys(CONTROL_OPERATION_ANCHOR) as
  readonly AgentMuxControlRequest['operation'][]

/**
 * 一条合法的磁盘记录。
 *
 * 为什么在这里再写一份而不从 agent-session-store.test.ts 里 import：`storedSession()` 在本仓是
 * **每个 suite 各持一份**的局部夹具（九个测试文件各有一份，形状按各自要驱动的字段裁剪），不是共享导出。
 * 这里跟着这个约定，但**加上类型注解**——`AgentMuxStoredAgentSession` 让 tsc 钉住形状：往必填字段里
 * 加东西时这份夹具会当场报错，而不是静默退化成"记录在到达被测的那道闸之前就因别的字段被拒"
 * （fixture-wrong-shape-blinds-the-test：那样一来「合法成员被放行」恒假、「非成员被拒」恒真，两侧
 * 都在描述别的错误）。下面每条断言还都比对**具体的错误消息**，为的是让这两种情形区分得开。
 */
function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 12,
    createdAt: 100,
    updatedAt: 200,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-1' }
  }
}

/** 一条**除了 `pendingInteraction.request.options[0].kind` 以外都合法**的磁盘记录。 */
function sessionWithPermissionKind(kind: unknown): Record<string, unknown> {
  return {
    ...storedSession(),
    semanticStatus: { state: 'waiting', source: 'native-hook', observedAt: 200, detail: 'PermissionRequest' },
    pendingInteraction: {
      request: {
        kind: 'permission',
        id: 'receipt-1',
        agentSessionId: 'semantic-1',
        title: 'Allow command?',
        options: [{ id: 'option-1', label: 'Proceed', kind }],
        evidence: {
          source: 'native-hook',
          observedAt: 200,
          run: { runId: 'daemon-1' },
          hookReceiptId: 'receipt-1'
        }
      }
    }
  }
}

/**
 * 同上，只让 `terminalPromptDelivery.reason` 变。
 *
 * `submissionId` / `observedAt` 必须在场且合法（`observedAt` 还必须 ≤ `updatedAt`），否则记录会拒在
 * **那道闸后面**的两行上。这不是猜的：第一版夹具漏了这两个字段，拒绝侧照旧全绿（因为 `reason` 在同
 * 一条析取里排在 `submissionId` 之前，非成员总是先撞上正确的那条消息），只有放行侧红了并如实报出
 * `terminalPromptDelivery.submissionId is invalid.`。这正是「比对具体消息」而不是「有没有抛」买到的东西。
 */
function sessionWithDegradedReason(reason: unknown): Record<string, unknown> {
  return {
    ...storedSession(),
    terminalPromptDelivery: {
      state: 'unverified',
      mode: 'degraded',
      reason,
      submissionId: 'prompt-submit-1',
      run: { runId: 'daemon-1' },
      observedAt: 200
    }
  }
}

/** 每条联合：锚点成员集合、它的收窄谓词、SSOT 应当住在哪个文件的哪个声明里。 */
const UNIONS = [
  {
    label: 'PermissionOptionKind',
    members: PERMISSION_KIND_MEMBERS as readonly string[],
    predicate: isPermissionOptionKind as (value: unknown) => boolean,
    ssot: { file: 'src/types.ts', declaration: 'PERMISSION_OPTION_KINDS' }
  },
  {
    label: 'PromptDeliveryDegradedReason',
    members: DEGRADED_REASON_MEMBERS as readonly string[],
    predicate: isPromptDeliveryDegradedReason as (value: unknown) => boolean,
    ssot: { file: 'src/types.ts', declaration: 'PROMPT_DELIVERY_DEGRADED_REASONS' }
  },
  {
    label: "AgentMuxControlRequest['operation']",
    members: CONTROL_OPERATION_MEMBERS as readonly string[],
    predicate: isAgentMuxControlOperation as (value: unknown) => boolean,
    // 这条联合的 SSOT 是 control.ts 的 `OPERATION_BUDGET`——一张 `Record<Operation, …>`，
    // 对象字面量而不是数组，所以 C 层在整个 src/ 里应当**一处完整枚举都找不到**。
    ssot: null
  }
] as const

describe('三条联合的成员判定只有一处声明', () => {
  describe('A 层（行为·谓词）：谓词接受每个成员、拒绝非成员', () => {
    for (const { label, members, predicate } of UNIONS) {
      it(`${label} 的谓词放行锚点里的每一个成员`, () => {
        // 锚点由 tsc 钉成联合的全集，所以这条同时是 ⊇ 方向的判据：谓词内部清单少一个成员就红，
        // 而那正是「合法磁盘记录/合法请求被 fail-closed 拒掉」的形状。
        expect(members.length, `${label} 锚点是空的，下面的循环是死代码`).toBeGreaterThanOrEqual(2)
        for (const member of members) {
          expect(predicate(member), `${label} 的谓词拒掉了合法成员 ${member}`).toBe(true)
        }
      })

      it(`${label} 的谓词拒绝非成员（含原型链上的键与近似拼法）`, () => {
        // `toString` / `constructor`：谓词若从 `Object.hasOwn` 退回 `in`（或退回一个 `{}` 上的取值判空），
        // 原型链上的键会被当成合法成员。近似拼法（大小写、截断）挡住"谓词只判前缀/长度"这类退化。
        for (const rejected of [
          undefined,
          null,
          123,
          '',
          'toString',
          'constructor',
          '__proto__',
          'hasOwnProperty',
          members[0]!.toUpperCase(),
          `${members[0]!}-x`,
          members[0]!.slice(0, -1)
        ]) {
          expect(predicate(rejected), `${label} 的谓词放行了非成员 ${String(rejected)}`).toBe(false)
        }
      })
    }
  })

  describe('B 层（行为·校验点）：真正的校验函数放行每个成员、拒掉非成员', () => {
    // 这一层的必要性见文件头的变异矩阵：M2（不完整手抄）在只有 A+C 时于 49 条里全绿存活。
    const REJECTED = {
      operation: 'Control operation is invalid.',
      permissionKind: 'Permission option kind is invalid.',
      degradedReason: 'Terminal prompt delivery state does not match its Agent Run.'
    } as const

    /** 跑一次校验，只把「抛出来的消息」交回去（null = 没抛）。 */
    function messageOf(run: () => unknown): string | null {
      try {
        run()
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    // control 请求：只喂 schemaVersion + requestId + operation。每个合法操作都会因为**别的**字段
    // 缺失而抛（target/destination 不合法），关键是它**不会**抛「操作不合法」。于是这条恰好只钉住那道
    // membership 闸，不连带钉住十二种请求各自的形状。
    it('每个操作全部越过 membership 闸（各自因别的字段失败，不是因为操作名）', () => {
      expect(CONTROL_OPERATION_MEMBERS.length, '操作锚点是空的，下面的循环是死代码').toBe(13)
      for (const operation of CONTROL_OPERATION_MEMBERS) {
        expect(
          messageOf(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'request-1', operation })),
          `合法操作 ${operation} 被 membership 闸拒掉了——校验点的清单与联合发散（fail-closed）`
        ).not.toBe(REJECTED.operation)
      }
    })

    it('不是操作名的值被响亮拒掉', () => {
      for (const operation of ['inspect', 'open', 'toString', '', 'Stop', 42, null]) {
        expect(
          messageOf(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'request-1', operation })),
          `非操作 ${String(operation)} 没有被拒`
        ).toBe(REJECTED.operation)
      }
    })

    it('四种权限答复方向全部越过 store 的 membership 闸', () => {
      expect(PERMISSION_KIND_MEMBERS.length, '权限锚点是空的，下面的循环是死代码').toBe(4)
      for (const kind of PERMISSION_KIND_MEMBERS) {
        expect(
          messageOf(() => normalizeStoredAgentSession(sessionWithPermissionKind(kind))),
          `合法答复方向 ${kind} 被拒掉了——那条合法磁盘记录会 fail-closed 丢掉`
        ).toBeNull()
      }
    })

    it('不是答复方向的 kind 被 store 响亮拒掉', () => {
      for (const kind of ['allow', 'deny', 'toString', '', 'Allow-once', 7, null, undefined]) {
        expect(
          messageOf(() => normalizeStoredAgentSession(sessionWithPermissionKind(kind))),
          `非答复方向 ${String(kind)} 没有被拒`
        ).toBe(REJECTED.permissionKind)
      }
    })

    it('全部降级原因越过 store 的 membership 闸', () => {
      expect(DEGRADED_REASON_MEMBERS.length, '原因锚点是空的，下面的循环是死代码').toBeGreaterThan(0)
      for (const reason of DEGRADED_REASON_MEMBERS) {
        expect(
          messageOf(() => normalizeStoredAgentSession(sessionWithDegradedReason(reason))),
          `合法降级原因 ${reason} 被拒掉了——那条合法磁盘记录会 fail-closed 丢掉`
        ).toBeNull()
      }
    })

    it('不是降级原因的 reason 被 store 响亮拒掉', () => {
      for (const reason of ['screen-gap', 'timeout', 'toString', '', 7, null, undefined]) {
        expect(
          messageOf(() => normalizeStoredAgentSession(sessionWithDegradedReason(reason))),
          `非降级原因 ${String(reason)} 没有被拒`
        ).toBe(REJECTED.degradedReason)
      }
    })
  })

  describe('C 层（结构）：拥有方之外没有第二处枚举整条联合', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const coreRoot = join(here, '..')

    /** src/ 下的所有 .ts（排除构建产物）。 */
    function sourceFiles(): string[] {
      return (readdirSync(join(coreRoot, 'src'), { recursive: true }) as string[])
        .filter((rel) => rel.endsWith('.ts'))
        .map((rel) => join(coreRoot, 'src', rel))
    }

    function parse(file: string, source: string): ts.SourceFile {
      return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    }

    /** 最近的一个具名声明（变量 / 函数 / 类 / 方法），用来说清"这处完整枚举住在谁身上"。 */
    function enclosingDeclarationName(node: ts.Node): string {
      for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
        if (
          (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) &&
          current.name
        ) {
          return current.name.text
        }
        if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
      }
      return '<top level>'
    }

    /**
     * 一份源码里「枚举出整条联合」的位置。
     *
     * 只认两种形状，各对应一种真实的 membership 手抄：
     *   - 数组 / Set 字面量：`['a','b',…].includes(x)`、`new Set(['a','b',…]).has(x)`；
     *   - 同一操作数上的 `=== 'a' || === 'b' || …` 链。
     *
     * 判据是**覆盖整条联合**。只覆盖真子集的表达式是分类判定（"这两种算拒绝"、"这三种走同一支解析"），
     * 按构造不承诺覆盖联合，加成员时也不会因为漏提而拒掉数据——所以它们不该被算进来，也因此这条判据
     * 不需要任何人手维护的豁免清单。
     */
    function completeEnumerationSites(
      sourceFile: ts.SourceFile,
      members: readonly string[]
    ): { declaration: string; shape: 'array' | 'or-chain' | 'and-chain' }[] {
      const required = new Set(members)
      const sites: { declaration: string; shape: 'array' | 'or-chain' | 'and-chain' }[] = []
      const covers = (found: ReadonlySet<string>): boolean =>
        [...required].every((member) => found.has(member))

      // 逻辑链有两种极性，**同为**一次完整的 membership 判定，De Morgan 互为等价：
      //   `x === 'a' || x === 'b' || …`   —— 「是成员吗」
      //   `x !== 'a' && x !== 'b' && …`   —— 「不是成员吗」，即 `!谓词(x)`
      // 只认前者是本守卫此前坐实的盲点：#711 那次提交从 `terminalPromptDelivery` 删掉的正是后者，
      // 而把它原样改回去（一行）在四个 suite 75/75 + tsc exit 0 下**实测存活**。两种极性都是"列全成员
      // 即成为第二个声明点"，判据必须对称，否则守的只是拼法的一半。
      const CHAINS = [
        {
          shape: 'or-chain' as const,
          chain: ts.SyntaxKind.BarBarToken,
          equality: [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]
        },
        {
          shape: 'and-chain' as const,
          chain: ts.SyntaxKind.AmpersandAmpersandToken,
          equality: [
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken
          ]
        }
      ]

      /** 一条同极性链上，同一个操作数被拿去与哪些字面量比过（相等或不等，由 `spec` 决定）。 */
      const chainLiterals = (
        node: ts.Expression,
        spec: (typeof CHAINS)[number],
        into: Map<string, Set<string>>
      ): void => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === spec.chain) {
          chainLiterals(node.left, spec, into)
          chainLiterals(node.right, spec, into)
          return
        }
        if (ts.isParenthesizedExpression(node)) {
          chainLiterals(node.expression, spec, into)
          return
        }
        if (!ts.isBinaryExpression(node)) return
        if (!spec.equality.includes(node.operatorToken.kind)) return
        for (const [operand, other] of [
          [node.left, node.right],
          [node.right, node.left]
        ] as const) {
          if (!ts.isStringLiteral(other)) continue
          const key = operand.getText(sourceFile)
          const found = into.get(key) ?? new Set<string>()
          found.add(other.text)
          into.set(key, found)
        }
      }

      const walk = (node: ts.Node): void => {
        if (ts.isArrayLiteralExpression(node)) {
          const found = new Set(
            node.elements.filter(ts.isStringLiteral).map((element) => element.text)
          )
          if (found.size >= 2 && covers(found)) {
            sites.push({ declaration: enclosingDeclarationName(node), shape: 'array' })
          }
        }
        for (const spec of CHAINS) {
          if (
            !ts.isBinaryExpression(node) ||
            node.operatorToken.kind !== spec.chain ||
            // 只从链**顶**开始收，否则同一条链的每个内部节点各报一次。
            (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === spec.chain)
          ) {
            continue
          }
          const byOperand = new Map<string, Set<string>>()
          chainLiterals(node, spec, byOperand)
          for (const found of byOperand.values()) {
            if (found.size >= 2 && covers(found)) {
              sites.push({ declaration: enclosingDeclarationName(node), shape: spec.shape })
            }
          }
        }
        node.forEachChild(walk)
      }
      sourceFile.forEachChild(walk)
      return sites
    }

    const files = sourceFiles()
    const parsed = files.map((file) => ({
      file,
      rel: relative(coreRoot, file),
      sourceFile: parse(file, readFileSync(file, 'utf8'))
    }))

    it('自检：扫描面真的抓到了 src/ 下的文件（否则下面几条在空集上恒绿）', () => {
      expect(parsed.length, 'src/ 扫描面是空的').toBeGreaterThanOrEqual(20)
      const rels = parsed.map(({ rel }) => rel)
      expect(rels).toContain('src/agent-session-store.ts')
      expect(rels).toContain('src/control-host.ts')
      expect(rels).toContain('src/types.ts')
    })

    for (const { label, members, ssot } of UNIONS) {
      it(`${label}：整条联合的枚举只出现在它自己的 SSOT 声明里`, () => {
        const sites = parsed.flatMap(({ rel, sourceFile }) =>
          completeEnumerationSites(sourceFile, members).map((site) => `${rel}:${site.declaration}`)
        )
        const expected = ssot ? [`${ssot.file}:${ssot.declaration}`] : []
        expect(
          sites.sort(),
          `${label} 在这些位置被完整枚举了一遍：${sites.join(', ') || '（无）'}。` +
            `一份列全成员的手抄就是这条联合的第二个声明点——它今天与派生行为完全相同，所以没有任何` +
            `行为测试分辨得出，而下一次往联合加成员时它会把合法数据 fail-closed 拒掉。改成问` +
            `拥有方导出的收窄谓词。`
        ).toEqual(expected.sort())
      })
    }

    it('自检：判据认得出「完整枚举」的三种形状，也真的放过真子集', () => {
      const complete = parse(
        'probe.ts',
        [
          "const asArray = ['allow-once', 'allow-always', 'reject-once', 'reject-always']",
          "function asChain(kind: string) { return kind === 'allow-once' || kind === 'allow-always' || kind === 'reject-once' || kind === 'reject-always' }",
          // De Morgan 形：`!谓词(x)` 的手抄展开。这一份是本守卫真实漏过的形状——#711 那次提交从
          // `terminalPromptDelivery` 删掉的正是它，而原样改回去在四个 suite 75/75 + tsc exit 0 下存活。
          "function asNegatedChain(kind: string) { return kind !== 'allow-once' && kind !== 'allow-always' && kind !== 'reject-once' && kind !== 'reject-always' }"
        ].join('\n')
      )
      expect(
        completeEnumerationSites(complete, PERMISSION_KIND_MEMBERS).map((site) => `${site.declaration}:${site.shape}`).sort(),
        '判据认不出完整的数组、|| 链或 && 取反链手抄——上面那几条是死代码'
      ).toEqual(['asArray:array', 'asChain:or-chain', 'asNegatedChain:and-chain'])

      // 真子集必须放过：这三处在 HEAD 上真实存在（acp-adapter 的「算不算拒绝」、control-host 的两处
      // 按操作分组解析）。把它们判成违规，这道门就只能靠人手豁免清单活着，而那种清单会漏。
      // 取反极性同样要放过真子集，否则「排除这两种」这类合法的分类判定会被误伤。
      const subset = parse(
        'probe.ts',
        [
          "function isRejection(kind: string) { return kind === 'reject-once' || kind === 'reject-always' }",
          "function notReject(kind: string) { return kind !== 'reject-once' && kind !== 'reject-always' }",
          "const twoOfFour = ['allow-once', 'reject-once']"
        ].join('\n')
      )
      expect(
        completeEnumerationSites(subset, PERMISSION_KIND_MEMBERS),
        '真子集的分类判定被误判成完整枚举'
      ).toEqual([])

      // 同一条链只报一次（否则计数会被链长度放大，上面的 toEqual 变成靠巧合相等）。
      const single = parse(
        'probe.ts',
        `function f(r: string) { return ${DEGRADED_REASON_MEMBERS.map((reason) => `r === '${reason}'`).join(' || ')} }`
      )
      expect(completeEnumerationSites(single, DEGRADED_REASON_MEMBERS)).toHaveLength(1)

      // 两个不同操作数各比一半，凑不成一次 membership 判定——不许把它们并起来算覆盖。
      const split = parse(
        'probe.ts',
        ["function f(a: string, b: string) { return a === 'screen-evidence-gap' || b === 'prompt-render-timeout' }"].join('\n')
      )
      expect(
        completeEnumerationSites(split, DEGRADED_REASON_MEMBERS),
        '两个不同操作数被并起来当成了一次完整枚举'
      ).toEqual([])
    })

    it('三个校验点都从拥有方 import 那个谓词（判 import 关系，不判裸标识符文本）', () => {
      // 判 import 关系而不是 `toContain('isPermissionOptionKind(')`：同名本地函数能骗过文本判据，
      // 而"自己又实现了一遍"这件事照旧发生（guard-criterion-must-be-import-relation）。
      const REQUIRED = [
        { rel: 'src/agent-session-store.ts', name: 'isPermissionOptionKind', from: './types.js' },
        { rel: 'src/agent-session-store.ts', name: 'isPromptDeliveryDegradedReason', from: './types.js' },
        { rel: 'src/control-host.ts', name: 'isAgentMuxControlOperation', from: './control.js' }
      ] as const

      /** 这个文件是不是从 `from` 具名 import 了 `name`（走 parser，不用正则）。 */
      const importsNamed = (sourceFile: ts.SourceFile, name: string, from: string): boolean =>
        sourceFile.statements.some((statement) => {
          if (!ts.isImportDeclaration(statement)) return false
          if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== from) return false
          const clause = statement.importClause
          if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false
          return clause.namedBindings.elements.some(
            (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name
          )
        })

      for (const { rel, name, from } of REQUIRED) {
        const entry = parsed.find((candidate) => candidate.rel === rel)
        expect(entry, `扫描面里没有 ${rel}`).toBeTruthy()
        expect(
          importsNamed(entry!.sourceFile, name, from),
          `${rel} 没有从 ${from} 具名 import ${name}——那个校验点的成员判定又变成自己一份了`
        ).toBe(true)
      }

      // 自检：判据认得出它要找的形状，且不被"同名但来自别处/只 import 了类型"骗过。
      const probe = parse(
        'probe.ts',
        [
          "import { isPermissionOptionKind } from './types.js'",
          "import { type isFromElsewhere } from './other.js'"
        ].join('\n')
      )
      expect(importsNamed(probe, 'isPermissionOptionKind', './types.js'), '判据认不出正常的具名 import').toBe(true)
      expect(importsNamed(probe, 'isPermissionOptionKind', './other.js'), '判据不看模块路径').toBe(false)
      expect(importsNamed(probe, 'isFromElsewhere', './other.js'), '判据把 type-only import 算成了值 import').toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// readiness-source 投影表的 `Record<union>` 注解不许被放宽——与 `OPERATION_BUDGET` 对称的守卫。
//
// `agent-session-store.ts` 里的 `TERMINAL_PROMPT_READINESS_SOURCE_MEMBERS` 是一张
// `Record<AgentTerminalPromptReadinessSource, true>`，运行时白名单 `TERMINAL_PROMPT_READINESS_SOURCES`
// 从它 `Object.keys` 投影出来。那条 `Record<Union, true>` **注解**是唯一逼这张表与联合保持 ⊇-完整的东西：
// 往联合加成员却忘了往表里加，tsc 报 TS2741（`dcaa46d` 要防的正是这种 fail-closed 数据丢失——带新成员的
// 合法磁盘记录会被 `INVALID_AGENT_SESSION_STORE` 拒掉，且无编译错误，而「加成员」正是常见方向）。
// **但在此之前没有任何东西守着注解本身**：把它放宽成 `Record<string, true>` 后，`npx tsc --noEmit` 退 0、
// 四个 suite 75/75 全绿（reviewer 实测），而此时再往联合加成员也照样编译通过（本轮实测 TSC_EXIT=0），
// ⊇ 漂移重新变沉默。一处编辑就把整道 tsc 守卫解除了。
//
// 兄弟表 `control.ts` 的 `OPERATION_BUDGET` 早有这道守卫（`control-host.test.ts`，见 `25dccc3`）。两张表
// 干同一件事——穷尽 `Record` 投影 + tsc 兜底缺键——所以守卫必须对称，否则其中一张的注解能被悄悄放宽而
// 另一张不能。这条就是补上那个不对称。
//
// **判据走 TS parser 判类型节点，不做文本 substring**（本仓 `readFileSync+toContain` 家族反复被换一种拼法
// 绕过）：外层必须是裸 `Record`（不是 `Partial`/`Pick`/`Readonly`/限定名），键类型参数必须是一个**具名类型
// 引用**且名字恰好是 `AgentTerminalPromptReadinessSource`（不是 `string`/`any` 关键字，也不是别的名字）。
//
// **看得见 / 看不见什么（务必知道——走 syntax-only 的 `createSourceFile`，没有 type checker）**：
//   - 判 VIOLATING（都实测过，见自检）：`Record<string, true>`、`Record<any, true>`、
//     `Partial<Record<Union, true>>`（⊇ 被破坏却「看着像对的」）、`Record<Loose, true>`（`type Loose = string`
//     的别名间接——键名是 `Loose` 对不上联合名，故照样红）、以及**完全没有注解**。
//   - fail-open 盲点（须申报）：若**联合定义本身**在 types.ts 被改宽成
//     `type AgentTerminalPromptReadinessSource = string`，本判据只看到键名字面仍是那个联合名，判 OK。没有
//     type checker 就分辨不出这一步。`OPERATION_BUDGET` 的文本判据有**完全相同**的盲点（它比对字面
//     `AgentMuxControlRequest['operation']`），故两张表的守卫在这点上对称；这条盲点由「改联合定义」这个显眼
//     动作与联合的其它消费者兜底，不在本守卫射程内。
//   - fail-loud（保守）盲点：若把注解写成 `Record<Alias, true>` 而 `type Alias = AgentTerminalPromptReadinessSource`
//     （一个指向联合的等价别名），本判据会**误红**。这是「逼人来看」的方向，不是数据丢失方向，可接受。
// ---------------------------------------------------------------------------
describe('readiness-source 投影表的 Record<union> 注解不许被放宽（与 OPERATION_BUDGET 对称）', () => {
  type AnnotationVerdict = { ok: true } | { ok: false; reason: string }

  const TABLE = 'TERMINAL_PROMPT_READINESS_SOURCE_MEMBERS'
  const UNION = 'AgentTerminalPromptReadinessSource'

  /**
   * 一个类型节点是不是「键覆盖整条联合的穷尽 `Record`」。判类型节点，不做文本比对。
   * 判 VIOLATING 的正是所有把 ⊇ 完整性悄悄放宽的写法：`Record<string,…>`、`Record<any,…>`、
   * `Partial<Record<…>>`、键名对不上联合名的任何间接、以及压根没有注解。
   */
  function exhaustiveRecordVerdict(
    typeNode: ts.TypeNode | undefined,
    unionName: string
  ): AnnotationVerdict {
    if (!typeNode) return { ok: false, reason: '没有类型注解——缺键不再报错，⊇ 回到「你得记得改」' }
    if (!ts.isTypeReferenceNode(typeNode)) return { ok: false, reason: '注解不是类型引用（Record<…>）' }
    if (!ts.isIdentifier(typeNode.typeName) || typeNode.typeName.text !== 'Record') {
      const outer = ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : '<限定名>'
      return { ok: false, reason: `外层不是裸 Record 而是 ${outer}（Partial/Pick/Readonly 会破坏 ⊇）` }
    }
    const keyArg = typeNode.typeArguments?.[0]
    if (!keyArg) return { ok: false, reason: 'Record 没有键类型参数' }
    if (!ts.isTypeReferenceNode(keyArg) || !ts.isIdentifier(keyArg.typeName)) {
      return { ok: false, reason: 'Record 的键类型不是具名类型引用（可能是 string/any 等关键字）' }
    }
    if (keyArg.typeName.text !== unionName) {
      return { ok: false, reason: `Record 的键类型是 ${keyArg.typeName.text}，不是穷尽联合 ${unionName}` }
    }
    return { ok: true }
  }

  function parseSource(fileName: string, source: string): ts.SourceFile {
    return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  }

  /** 源码里所有名为 TABLE 的变量声明（走 parser，不用正则）。 */
  function tableDeclarations(sourceFile: ts.SourceFile): ts.VariableDeclaration[] {
    const found: ts.VariableDeclaration[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === TABLE) {
        found.push(node)
      }
      node.forEachChild(walk)
    }
    sourceFile.forEachChild(walk)
    return found
  }

  it(`${TABLE} 的注解是穷尽 Record<${UNION}>——放宽它会让 ⊇ 漂移重新变沉默`, () => {
    const source = readFileSync(new URL('../src/agent-session-store.ts', import.meta.url), 'utf8')
    const decls = tableDeclarations(parseSource('agent-session-store.ts', source))
    // 找不到目标（被改名 / 搬走）必须红，不许在空集上恒绿——本仓最常见的一种假绿。
    expect(
      decls.length,
      `agent-session-store.ts 里找不到 ${TABLE} 声明（被改名 / 搬走？）——守卫看不见它的目标就必须红`
    ).toBe(1)
    const verdict = exhaustiveRecordVerdict(decls[0]!.type, UNION)
    expect(
      verdict.ok,
      verdict.ok
        ? ''
        : `${TABLE} 的注解不是穷尽 Record<${UNION}>：${verdict.reason}。放宽后往联合加成员不再报 TS2741，` +
            `带新成员的合法磁盘记录会被 fail-closed 丢掉（dcaa46d 要防的正是这个）`
    ).toBe(true)
  })

  it('自检：判据认得放宽 / 穷尽 / 间接各种写法（否则上面那条只是在描述今天的字面量）', () => {
    const verdictOf = (annotation: string): AnnotationVerdict => {
      const decls = tableDeclarations(parseSource('probe.ts', `const ${TABLE}: ${annotation} = {}`))
      expect(decls, `自检源码里没解析出 ${TABLE}`).toHaveLength(1)
      return exhaustiveRecordVerdict(decls[0]!.type, UNION)
    }
    // 穷尽 Record<union>：唯一 OK 的形状。
    expect(verdictOf(`Record<${UNION}, true>`).ok, '判据把正确的穷尽注解误判成违规').toBe(true)
    // 放宽成 string / any：reviewer 实测能一键解除守卫的两种。
    expect(verdictOf('Record<string, true>').ok, '判据认不出被放宽成 Record<string> 的注解').toBe(false)
    expect(verdictOf('Record<any, true>').ok, '判据认不出被放宽成 Record<any> 的注解').toBe(false)
    // Partial<Record<union>>：⊇ 被破坏但「看着像对的」。
    expect(verdictOf(`Partial<Record<${UNION}, true>>`).ok, '判据认不出 Partial<Record<…>>（⊇ 被破坏）').toBe(false)
    // 我没有第一时间想到的形状：经类型别名 `type Loose = string` 的间接。键名是 Loose 不是联合名，故被抓。
    expect(verdictOf('Record<Loose, true>').ok, '判据放过了经别名间接放宽的注解').toBe(false)
    // 完全没有注解：缺键彻底不报错。用不带注解的声明喂进去。
    const noAnnotation = tableDeclarations(parseSource('probe.ts', `const ${TABLE} = {}`))
    expect(noAnnotation, `自检源码里没解析出无注解的 ${TABLE}`).toHaveLength(1)
    expect(exhaustiveRecordVerdict(noAnnotation[0]!.type, UNION).ok, '判据把「没有注解」当成了 OK').toBe(false)
    // 自检：找不到目标时返回空集——上面那条主断言的 `.toBe(1)` 才是真闸，不是恒真。
    expect(tableDeclarations(parseSource('probe.ts', 'const other = {}')), '判据在无关源码里凭空找出了目标').toHaveLength(0)
  })
})
