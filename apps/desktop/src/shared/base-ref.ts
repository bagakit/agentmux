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
 *
 * ## 同一个事实，两个拼法——这是本模块第二次栽在这上面
 *
 * 「两种用法」还不止于分级：两个消费方要的**字符串本身**就不同。`gh pr create --base` 收分支名
 * （`main`），而 `rev-list --not <base>` 要一个**本地解析得开**的 revision（`origin/main`）。
 * `origin/HEAD` 的原话是 `origin/main`，两者都在里头；早先只留了剥过的那半，于是数独有提交那条路
 * 拿 `main` 去解析，在本地没有同名分支的仓里 fatal（实测 128），警告静默消失。
 *
 * {@link plainBranchName} 上面记的那个 bug 是同一个形状的第一次（`ls-remote` 剥了、`gh` 没剥）。
 * 结论写在这里免得有第三次：**判身份的 ref 和真正拿去用的 ref 必须是同一个**；一份事实要服务两种
 * 拼法时，两个拼法都得留在结构里，而不是留一个、让消费方各自去还原。
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
  /**
   * 人读的分支名，`origin/` 已剥掉（`main`）。开 PR 用它——`gh pr create --base` 收的是分支名。
   */
  ref: string
  /**
   * **本地够得着的那个 ref**（`origin/main`），只有权威档才有。
   *
   * 为什么两个字段而不是一个：`origin/HEAD` 的原话是 `origin/main`，而两个消费方要的拼法不同——
   * 开 PR 要分支名，数独有提交要一个**本地解析得开**的 revision。它们不是同一个字符串，早先只留
   * 剥过的那半，于是数数那条路拿 `main` 去解析。
   *
   * 这个区分有实测代价（一次性 repo，真 git）：`git clone --branch feature-x` 之后 `origin/HEAD`
   * 在（走权威档），本地却**没有** `main`——
   *
   * | 拿去数的 ref | `git rev-list --count lane --not <ref> --remotes --` |
   * | --- | --- |
   * | `main`（剥过的） | `fatal: bad revision 'main'`，退出码 128 |
   * | `origin/main`（这里这个） | `1` |
   *
   * 128 会被 `parseOrphanCommitCount` 老实读成 null，所以不会说出「删得放心」这种错话——但那句
   * 警告就此**静默消失**，而失效的场景恰恰是 fan-out：签出一条 feature 分支再在上面开 lane，是这
   * 个产品的主线玩法，不是边角。
   *
   * 猜测档没有这个字段（`null`）：`origin/` 前缀是从远端那句原话里**读**出来的，不是拼出来的。
   * 远端叫别的名字（`upstream`）时拼 `origin/main` 会指向另一条分支或不存在的 ref——而本模块的全部
   * 主张就是不拿猜的东西去数。
   */
  remoteRef: string | null
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
 * 输出形如 `origin/main`。**两个拼法都留着**：剥过的 `main` 给开 PR，原样的 `origin/main` 给数独有
 * 提交（见 {@link BaseRef.remoteRef} 上那张实测表——只留剥过的那半，数数会在本地没有同名分支时
 * fatal，警告静默失效）。取不到就是 `fallback`——**带着标签**，绝不假装是查到的。
 */
export function parseRemoteHead(stdout: string, exitCode: number): BaseRef {
  const guess = { ref: FALLBACK_BASE_REF, remoteRef: null, source: 'fallback' } as const
  if (exitCode !== 0) return guess
  const remoteRef = stdout.trim()
  const ref = plainBranchName(remoteRef)
  // 空输出是「没查到」，不是「查到了一个空名字」。
  return ref ? { ref, remoteRef, source: 'remote-head' } : guess
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
 *
 * ## 给出来的是 `remoteRef`（`origin/main`），不是 `ref`（`main`）
 *
 * 这里曾经给的是 `ref`。它是给**开 PR** 用的那个拼法（`gh pr create --base main`），拿去 `rev-list`
 * 就成了「本地有没有一条叫 main 的分支」——而 `git clone --branch feature-x` 出来的仓里没有，git
 * fatal（实测退出码 128，见 {@link BaseRef.remoteRef} 的表）。降级是安全的（128 读成 null，说
 * 「没查出来」而不是「删得放心」），但那句警告在 fan-out 这个主线场景里**静默不再出现**。
 *
 * 判身份的 ref 必须和真正拿去用的 ref 是同一个——这条教训 {@link plainBranchName} 上面已经写过一次
 * （`ls-remote` 剥了前缀、`gh pr create` 没剥），这里是它的第二次现形：同一个 `BaseRef` 服务两个
 * 消费方，而两个消费方要的拼法本就不同。所以现在两个拼法都在，各取各的。
 */
export function orphanCountableRef(base: BaseRef): CountableBaseRef | null {
  if (base.source !== 'remote-head') return null
  // 权威档必有 remoteRef（同一次解析里一起产出），这里的 `?? null` 只是不靠"必有"这句话吃饭。
  return (base.remoteRef as CountableBaseRef | null) ?? null
}
