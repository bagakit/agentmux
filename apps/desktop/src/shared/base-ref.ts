/**
 * 「这个仓的 base 分支是哪条，以及这个答案是不是权威的」——全仓唯一一处判定。
 *
 * ## 为什么要抽出来
 *
 * 这件事原本只长在 `gh-service.ts` 的**私有**方法 `resolveBaseRef` 里，服务于开 PR。现在删
 * worktree 前也要问同一个问题（「这条分支上有没有只存在于它自己身上的提交」必须相对某个 base 来数，
 * 见 `lane-orphan-commits.ts`）。私有方法够不着，照抄一份就是同一个概念两处判定——本仓反复栽的坑。
 *
 * 抽出来的是**判定与分级**这两件纯的事。跑 git 仍然在调用方（main 侧）：renderer 是沙箱，没有
 * node 内置模块也没有进程（`main/window-security.ts:44`），所以这里不碰进程，只给实参和解释结果，
 * 与 `fanout-naming.ts` / `fanout-limits.ts` 同形。
 *
 * ## 答案分两档，而且这个区分是有后果的，不是标注好看
 *
 * `origin/HEAD` 是远端自己声明的默认分支，是唯一真答案。它**经常缺席**：`git clone` 会写，而本地
 * 建库再推上去的仓从来没有——本仓自己就没有（`git symbolic-ref refs/remotes/origin/HEAD` 当场
 * fatal，实测）。所以缺席是常态不是边角，退路必须被**标成猜测**而不是冒充知识。
 *
 * ## 猜出来的 base 不许用来数「独有提交」——这条是实测定下来的
 *
 * 两个方向的错都试过（一次性 repo，真 git）：
 *
 * | 猜的 base 与真 base 的关系 | 真实独有数 | 按猜的数出来 | 后果 |
 * | --- | --- | --- | --- |
 * | 猜的是条**过时**分支（落后于真 base） | 1 | **2** | 多报，偏安全——多问一句而已 |
 * | 猜的分支**已经含有这条 lane**（有人本地 merge/ff 过） | 1 | **0** | **少报，致命** |
 *
 * 第二行是全部理由。`0` 在产品里的意思是「查过了，没有独有提交，删得放心」，而此时那批提交只活在
 * 本地 ref 上（实测 `git branch --contains lane` 给出 `lane` 和 `main`，远端一个都没有）。用户照着
 * 这句话删掉签出，产出就只剩一个分支名拴着。而这个形态是**真会发生**的：退路猜的就是字面量 `main`
 * （`PR_FALLBACK_BASE`），任何真实 base 不叫 main、同时本地又有一条 main 的仓都会撞上。
 *
 * 本仓的原则是：说「没查出来」永远可以，说「安全」而其实没查过永远不行。所以猜来的 base 在这里
 * 直接降级成「没查出来」，而不是拿去数一个可能读作 0 的数。
 *
 * 注意这**不适用于开 PR 那一侧**：那边把猜测显示给用户、让他改了再提交（`PrLaunchSurface.tsx:109`
 * 原话就是「so {baseRef} is a guess. Check it before...」），人看着改，是另一种正确的处理。同一个
 * 事实两种用法，所以这里只负责如实分级，由各自的消费方决定拿它干什么。
 */

/** base 这个答案是从哪来的。`remote-head` 是远端自己说的，`fallback` 是我们猜的。 */
export type BaseRefSource = 'remote-head' | 'fallback'

declare const countableBrand: unique symbol

/**
 * 一个**已经过分级的** base ref。数独有提交的入口只收这个类型。
 *
 * 品牌类型在本仓是要讲理由的，这里的理由是：`orphanCountableRef` 返回 `string | null` 之后，规则仍然
 * 只挡得住「忘了问」，挡不住「不问」——`orphanCommitCountArgs({ baseRef: base.ref })` 照样编译得过，
 * 而那正是会读出 0（「删得放心」）的那条路。改成只有本模块铸得出的类型之后，想数就必须先分级，绕过
 * 要写一句显式的 `as`——从「漏了一步」变成「明知故犯」。
 *
 * 只是个 string，运行时零开销；`unique symbol` 从不被赋值，纯粹用来让结构类型对不上。
 */
export type CountableBaseRef = string & { readonly [countableBrand]: true }

export type BaseRef = {
  ref: string
  source: BaseRefSource
}

/**
 * 猜不出来时用哪个名字。
 *
 * 一个字面量，没有别的聪明办法——重点从来不是猜得准，而是**猜了要说自己在猜**。
 */
export const FALLBACK_BASE_REF = 'main'

/** 问远端要它声明的默认分支。调用方自己跑 git。 */
export function remoteHeadArgs(repoPath: string): string[] {
  return ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']
}

/**
 * 去掉 ref 前面那个 `origin/`。
 *
 * **锚定且只去一次**，两条都是有代价的教训换来的：
 * - 不锚定（`/origin\//`）会吃掉 `feature/origin/rework` 的中段；
 * - 去多次会让某个别名远端下真叫 `origin/thing` 的分支少一节。
 *
 * 这份判定原本长在 `gh-service.ts` 的私有 `plainBranchName` 里，起因是一个真实的 bug：`ls-remote`
 * 预检把前缀剥了、而 `gh pr create` 的 argv 没剥，于是 `origin/main` 被确认"存在"为 `main`，再以
 * `origin/main` 交给 gh。**判身份的那个 ref 必须和真正拿去用的那个 ref 是同一个**。
 *
 * 搬到这里是因为现在有了第二个消费方（删 worktree 前数独有提交）。两处各写一遍正则，就是让那个
 * bug 有机会在第二条路上重演一次。
 */
export function plainBranchName(ref: string): string {
  return ref.replace(/^origin\//u, '')
}

/**
 * 把 `symbolic-ref` 的输出变成 base 答案。
 *
 * 输出形如 `origin/main`，要的是后面那半。取不到就是 `fallback`——**带着标签**，绝不假装是查到的。
 */
export function parseRemoteHead(stdout: string, exitCode: number): BaseRef {
  if (exitCode !== 0) return { ref: FALLBACK_BASE_REF, source: 'fallback' }
  const ref = plainBranchName(stdout.trim())
  return ref ? { ref, source: 'remote-head' } : { ref: FALLBACK_BASE_REF, source: 'fallback' }
}

/**
 * 这个 base 够不够格用来数「独有提交」——够格的话，**连 ref 一起给出来**。
 *
 * 只有权威答案够格，理由见本文件顶部那张表：猜来的 base 在「它已经含有这条 lane」时会读出 0，而 0
 * 的意思是「删得放心」。少报一次的代价是用户照着一句错的安心话删掉自己的东西。
 *
 * ## 为什么返回 `CountableBaseRef | null` 而不是 `boolean`，也不是裸 `string`
 *
 * 返回布尔的版本写出来是这样的：
 *
 * ```ts
 * if (canCountOrphanCommits(base)) count(base.ref)   // 守住了
 * count(base.ref)                                     // 也编译得过，而且没人会红
 * ```
 *
 * 也就是说规则**全靠调用方自觉去问**，而这正是本仓反复证明无效的那种守卫：靠注释和自觉挡不住下一个
 * 人。返回「够格时才给得出的那个 ref」把它推进了一格——不问就没有 ref 可用。
 *
 * 但只推进一格还不够：裸 `string` 之下 `orphanCommitCountArgs({ baseRef: base.ref })` 依然编译得过，
 * 于是绕过仍然只是"少写一行"。所以这里铸的是 {@link CountableBaseRef}，而数独有提交的入口只收它。
 * 现在绕过必须显式写一句 `as CountableBaseRef`——那已经不是"忘了检查"，而是在一个明说了理由的类型上
 * 签字。审计这个模块时，`as CountableBaseRef` 就是唯一要看的那个字符串。
 *
 * 把判定和取值合成一次，也顺带消掉了「判的那次和用的那次之间 base 变了」这类两次解析的漂移。
 */
export function orphanCountableRef(base: BaseRef): CountableBaseRef | null {
  return base.source === 'remote-head' ? (base.ref as CountableBaseRef) : null
}
