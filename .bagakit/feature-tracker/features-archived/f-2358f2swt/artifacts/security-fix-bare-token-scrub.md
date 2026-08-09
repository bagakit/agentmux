# f-2358f2swt T-003 安全缺陷：bare-token 形式的凭据未被擦除

日期：2026-08-29
发现者：独立 Reviewer（未参与实现）
复核与修复：主 session（实测复现，非采信自述）
严重级别：blocking（凭据泄露到 UI 与日志）

## 缺陷

`scrubGitCredentials` 原实现只匹配**带冒号**的 userinfo：

```js
/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]*:[^@/\s]*@/g
```

因此只擦得掉 `https://alice:ghp_secret@github.com/…` 这种 user:pass 形式。
而 GitHub PAT 最常见的嵌入方式是 **bare-token**——userinfo 里**没有冒号**，
整段 userinfo 本身就是 token：

```
https://ghp_TOKEN@github.com/o/r.git
```

这正是 CI 与 `git remote set-url origin https://$TOKEN@github.com/...` 的标准写法。
这种形式**逐字泄露**。

## 复现（实测，不是推断）

```js
scrub("fatal: https://alice:ghp_secret@github.com/o/r.git rejected")
→ "fatal: https://***@github.com/o/r.git rejected"        // 擦掉了

scrub("fatal: https://ghp_REALTOKEN123@github.com/o/r.git rejected")
→ "fatal: https://ghp_REALTOKEN123@github.com/o/r.git rejected"   // 原样泄露
```

## 为什么它通过了 gate —— 值得记住的教训

T-003 的 gate 我跑过并通过，我还专门对 scrubGitCredentials 做过变异验证
（移除擦除调用 → 3 条断言变红），据此判定"凭据擦除被守住了"。

**但那 3 条断言用的全是 `alice:ghp_secret` 形式**。变异验证只能证明
"某条代码路径被某些断言覆盖"，**证明不了断言覆盖的输入空间是完整的**。
擦除函数被调用了——这一点被守住了；擦除规则本身漏了一半输入——这一点没有任何断言。

即：变异验证守的是"这行代码有没有用"，不是"这个规则对不对"。
两者都需要，而后者要靠对**输入形态**的枚举，不能靠变异。

## 修复

把规则放宽到擦除 http(s) 类 URL 的**全部 userinfo**（含无冒号的单段形式）：

```js
/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]+@/g
```

`://` 前缀是安全放宽的关键：ssh remote 写作 `git@github.com:o/r`（**没有** `://`），
因此永远不匹配，`git@…` 这个用户名得以保留——它是身份不是秘密，
擦掉它只会毁掉报错里唯一有用的信息，却不多隐藏任何东西。

## 新增断言（三条，覆盖输入形态而非仅代码路径）

1. user:pass 形式被擦除（既有）
2. **bare-token 形式被擦除**（新增，修复前必红）
3. **ssh 的 `git@host` 保留**（新增，防止修复过头）

变异验证：把规则改回只匹配冒号 → `1 failed | 27 passed`。已还原并 diff 确认。

## 附：Reviewer 同时提出的一条 minor（已记录，未修）

`assertSafeRef` 禁止 `:`，但被应用在名为 `refspec` 的字段上，而真正的 refspec
合法地含冒号（`src:dst`）。当前唯一调用方传的是默认 `'HEAD'`，故 T-003 范围内无害；
但契约类型承诺 refspec、校验器却拒绝任何真 refspec，将来传 `HEAD:refs/heads/x`
的调用方会撞上一条费解的报错。留待有真实需求时再决定是改名还是双侧校验——
现在改属于为未证明的需求预建，违反项目原则。

---

# 同轮的另外两条独立审查发现（T-004 / T-005）

## T-005：转义追踪是空测试 —— 已补断言并变异验证

`pr-fields.ts:242-243` 的字符串状态机里，`\"` 必须被当作转义而不是字符串结束符。
坏掉的话，DoS 结构守卫会把字符串内容里的花括号误读成真实嵌套，从而**拒绝合法输入**。

原有那条 `handles an escaped quote...` 测试**证明不了这件事**：它的载荷即使状态机错了
`JSON.parse` 依然成功，于是断言照样绿。实测把 `else if (ch === '\\')` 改成
匹配一个永不出现的字符（语义中和、语法完好）：**33 passed，全绿**。

补了两条打在**守卫判决**而非 parse 成败上的断言：

- 转义引号之后跟 300 个花括号：追踪正确时它们是字符串内容、不计深度；
  误读则会被当成 300 层真实嵌套而拒绝合法输入。
- 以反斜杠结尾的值：不消费转义就会永远停在"字符串内"，再也数不到真实结构。

补后 35 passed。**同一个变异现在 1 failed | 34 passed**。已还原并 diff 确认。

这与 bare-token 那条是同一类教训：变异验证要打在**规则的判决**上，
而不是打在"下游还能不能跑通"上——后者常常掩盖规则本身的错误。

## T-004：pr-eligibility 零生产调用者 —— 归属 T-006，已记录

`pr-eligibility.ts:54 evaluatePrEligibility` 与 `:77 PR_BLOCKER_MESSAGES`
全仓 grep 只有自己的测试引用，没有任何组件、store、hook 或 IPC 调用它。

这是本轮反复出现的同一形态（扇出、move-session-view 都踩过）：
纯函数与测试齐备，但竖切没闭合，用户不可达。

**不在 T-004 范围内修**：它是纯 renderer 助手，按 tasks.json 的任务分解，
消费它的是 T-006（创建 PR 的一键流：资格阶梯 → 生成字段 → gh pr create）。
T-006 正在实现中，其验收明确要求 renderer 资格探测接入且后端 preflight 终裁。
若 T-006 交付后它仍无调用者，那才是真缺口——已写入本记录以便收口时核对。

一条 minor（记录不修）：`upstream === null` 时 no-upstream 与 not-ahead 会同时上报，
后者文案在"根本没有 upstream"的状态下有误导。因阶梯是 report-all，
用户仍会看到正确可操作的 no-upstream 项，主 blocker 无误，故不阻断。
