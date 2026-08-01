/**
 * 启动失败时给用户看的那段话。
 *
 * 为什么需要它：`index.ts` 的 `exitAfterFailure` 原本只 `process.stderr.write` 然后 `app.exit(1)`，
 * 而整个主进程没有任何 `dialog.showErrorBox` 调用。从终端 `npm start` 的开发者能看到那行错误；而从
 * Finder 双击的用户看到的是 **Dock 图标弹一下就消失，什么都不说**——stderr 没有任何人在读。
 *
 * 这让三族「刻意的响亮拒绝」在真实用户那里全部退化成静默失败：配置文件的容器形状读不出时
 * （`config-store.ts` 里那四道守卫），它们的整个设计前提是「拒绝启动，让用户知道盘上的东西还在、
 * 并告诉他去修哪个字节」。用户看不到那段话，就只剩「应用坏了」这一个印象，而他手上那份完好的配置
 * 正因为没人告诉他而可能被他自己删掉重装。
 *
 * 所以这里的产出不是「一句错误提示」，而是三件事：**盘上的东西还在**、**是哪个文件**、
 * **原始的诊断串**。前两件是用户能行动的部分，第三件是拿来搜索或贴给我们的。
 */

/**
 * 用户数据文件的位置。这些串**只**用来告诉用户去哪里看，不参与任何逻辑判定。
 *
 * 之所以做成入参而不是在这里 `app.getPath` 现取：这个模块要能在没有 electron 的测试环境里跑，而
 * `app.getPath` 在模块加载期就会炸（见 `config-store.ts:196` 那次同形事故）。
 */
export interface StartupFailurePaths {
  /** 主配置文件（项目、host、Executor 都在里面）。 */
  configPath: string
}

export interface StartupFailureNotice {
  /** 原生对话框的标题栏文字。 */
  title: string
  /** 正文。多行，用 `\n` 分隔。 */
  body: string
}

/**
 * 把一个启动期异常变成给用户看的通知。
 *
 * 判据是「用户读完之后知不知道下一步做什么」，所以正文固定包含配置文件路径——即使这次的错误与配置
 * 无关。理由是不对称的：配置无关的错误里多一行路径只是噪音，而配置相关的错误里少那一行，用户就
 * **没有任何线索**知道该看哪里，而那恰好是本仓已知的、会真的发生的那一类失败。
 *
 * 不做的事：不解释、不猜原因、不给「请重装」这种建议。重装会删掉用户的配置，而拒绝启动的全部意义
 * 就是那份配置还在盘上没被覆盖。
 */
export function startupFailureNotice(
  error: unknown,
  paths: StartupFailurePaths
): StartupFailureNotice {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    title: 'AgentMux could not start',
    body: [
      detail,
      '',
      // 明确说「没被改过」：这是那些守卫拒绝启动换来的唯一好处，不说出来就等于没换到。
      'Your data on disk has not been changed. AgentMux stopped before writing anything.',
      `Configuration file: ${paths.configPath}`
    ].join('\n')
  }
}
