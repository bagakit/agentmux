# AgentMux 功能消失案例：旧包与错误启动副本

状态：approved

## 目标

记录“功能已经在 Git 中完成，但用户界面看不到”这一真实事故，优先解释它是如何
被旧 App 包或错误启动路径遮住的，而不是把并发提交中包含别人的改动误判成问题。

## 决策

1. 案例放在 `docs/casestudy/`，按用户看到的现象命名。
2. 每篇固定记录：现象、排除过的假设、真正根因、改进动作、证据和记忆句。
3. 先核对运行实例的 `package-identity.json`（source commit/tree、版本、平台、架构）
   与 clean main/候选包；版本号相同不能证明是同一份代码。
4. 只有同一次 clean build 的 `release/mac/AgentMux.app` 与同批 DMG 才是可安装事实；
   `out`、旧 `release` 或其他同名 App 只能作为排查对象，不能直接安装。
5. 共享 `git add` 继续允许；案例不把“提交带上另一 Agent 的已完成改动”当作事故，
   只记录会导致最终错误或无法判断来源的状态，并要求留下可核对证据。

## 非目标

- 不通过截图或版本号推断源码发生回滚。
- 不自动删除用户数据、Session、Run 或 Application Support。
- 不新增第二份包、Session 或布局真相，也不把案例写成固定数量的门禁清单。
