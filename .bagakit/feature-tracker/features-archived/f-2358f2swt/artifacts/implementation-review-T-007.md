# f-2358f2swt 独立实现审查（T-007 收尾）

日期：2026-08-29
审查者：主 session
方法：对着工作树真实代码核对 + 实测变异验证，不采信自述

审查重点按 T-007 验收原文：**是否存在任何路径把凭据/token 带进 UI 或日志**、
**intent 切 worktree 时是否真的不劫持新选中**、**测试能否在这些不变量被破坏时变红**。

---

## 一、凭据从不进入 UI 或日志 —— 通过（含本轮修掉的一个真实泄露）

### 曾经的真实缺陷

`scrubGitCredentials` 原实现只匹配**带冒号**的 userinfo，因此
`https://ghp_TOKEN@github.com/…`（bare-token，无冒号）**逐字泄露**。
这正是 CI 与 `git remote set-url origin https://$TOKEN@…` 的标准写法。
实测复现、已修复为擦除 http(s) 的全部 userinfo，同时保留 ssh 的 `git@host`
（那是身份不是秘密，擦掉只会毁掉报错里唯一有用的信息）。
详见 `artifacts/security-fix-bare-token-scrub.md`。

### 全路径核实

对 main 侧所有把 git/gh 输出变成人可见文本的位置逐一核对：

- `git-service.ts:156` `classifyGitRemoteError` —— 已擦
- `git-service.ts:623` `assertGit` —— 已擦
- `gh-service.ts:164` gh 失败信息 —— 已擦
- `gh-service.ts:167` 创建成功返回的 URL —— 已擦（PR URL 也可能回显远程）
- `gh-service.ts:170` 抛出的异常信息 —— 已擦

反向核实：grep 是否存在**未经擦除**就返回 `result.stderr` / `result.stdout` 的路径，
**零命中**。没有绕过擦除的旁路。

### 变异验证

- 移除 `classifyGitRemoteError` 的擦除调用 → **3 failed**
- 把规则改回只匹配冒号（即恢复 bare-token 泄露）→ **1 failed | 27 passed**

均已还原并 diff 确认逐字节一致。

## 二、intent 切 worktree 不劫持 —— 通过（方向正确，且被守住）

这条最容易实现反：把"切到别处"当成冲突，用户开个新窗口就丢掉正在建的 PR。

`create-pr-intent.ts` 的判定：

- `current.worktreeId !== token.worktreeId` → **`proceed-detached`**，运行照常完成，
  payload 打到**原** worktree/分支。切走不是冲突。
- 同一 worktree 内 branch 或 base 漂移 → **`conflict`** 并中止。
- base 比较经 `normalizeBaseRef` 归一：`origin/main` ≡ `refs/remotes/origin/main`，
  但 **`upstream/main` 绝不等价**——折叠远程名会让 PR 打到用户没选的仓库。

变异验证（两条方向各一）：

| 注入的缺陷 | 结果 |
|---|---|
| 把"切 worktree"改判为 conflict（经典反向 bug） | **1 failed** |
| 归一化时把远程名整段剥掉（upstream ≡ origin） | **3 failed** |

## 三、后端 preflight 终裁且 unavailable 即拒 —— 通过

`gh-service.ts:121 createPullRequest` 在调 gh 之前用
`git ls-remote --exit-code --heads origin <base>` 重查 base：

- exit 0 → base 存在，放行
- exit 2 → base 不存在，**refused**
- **其余任何 exit 或抛错 → refused**（"我查不了"不等于"没问题"）

变异验证：把 catch 分支改成 `exitCode: 0`（即 fail-open）→ **1 failed**。

另核实：refused 路径下 **gh 从未被调用**（断言检查了 mock 调用列表），
所以拒绝时外部世界确实没有被写入。

## 四、写操作不重试 —— 通过

`createPullRequest` 无任何重试包装；断言直接检查 gh 调用次数 === 1。
重试会开出第二个 PR，这是不可撤销的外部副作用。

## 五、argv 硬化 —— 通过

- 全部数组传参，无 shell 字符串拼接。
- `assertSafeGhRef` 与 git 侧 `assertSafeRef` **共用同一套拒绝字节集**
  （空、`-` 前缀、`\0\n\r\t` 空格 `~^:?*[\`），两个二进制守同一条规则而非各自发明。
  断言覆盖 `--upload-pack=evil` 这类会被读成 flag 的 base。
- PR 正文经**临时文件** + `--body-file` 传递，绝不进 argv（正文长度无上界），
  且 `finally` 里无条件删除——用户的散文不留在临时目录。

## 六、竖切闭合 —— 本次补齐

审查中发现 `pr-eligibility.ts` 的 `evaluatePrEligibility` / `PR_BLOCKER_MESSAGES`
**零生产调用者**（与本轮扇出、move-session-view 同一形态）。
按 tasks.json 的分解它应由 T-006 消费，但初版 store action 直接跳过了它。

已接入：store 的 `createPullRequest` 先跑阶梯，不合格时把每个 blocker 的
**可操作文案**（"先 push 建立 upstream"、"运行 gh auth login"）汇总报出，
而不是让用户去猜 gh 的原始报错。阶梯是**提示**，main 的 preflight 仍是终裁。

并加了三条钉住接线的断言（run-token 被检查、阶梯被调用且渲染其文案、
gh 经 preload bridge 而非 web preview mock）——接线前均为红。

## 七、门禁

`pnpm check` 通过：typecheck + **1301 passed** / 0 failed / 3 skipped + build 成功。

## 结论

无遗留 blocking 发现。四条不可退让约束（argv 不拼 shell、错误擦凭据后上浮、
run-token 切 worktree 不劫持、preflight 终裁且 unavailable 即拒）
在代码中成立，且每条都有在被破坏时变红的断言。
