# 书签文件，与对话里的贴图

Date: 2026-09-15
Scope: 两条用户确认要做的 Browser/对话能力。
Status: approved for implementation.

## 1. 用户要的是什么

1. **书签文件**（`f-26e8f6h4z`）。浏览器能把一个链接存成本地文件、也能打开这种文件。
   单条走标准格式不自造：`.webloc`（macOS plist，键 `URL`）与 `.url`（`[InternetShortcut]`）。
   存下来的文件必须能被 Finder 和别的浏览器直接打开。
2. **对话里的贴图**（`f-24d8fcuhy`）。粘一张图进对话，今天只出现一个文件链接按钮，看不到图。
   要显示缩略图、点击放大。**路径这个表示必须保留**——Agent 要靠它读图。

用户在本轮明确的三个决定，逐字记在这里：

- 「**应该是默认 browser**」——在 AgentMux 里打开一个书签文件，走 AgentMux 自己的 Browser，
  不递给 Safari。
- 「**查看源码指的是书签文件本身的源码**」——打开书签之后要能切过去看 `.webloc` 的 plist 原文。
  网页 HTML 源码不在此列，DevTools 已经覆盖。
- 「**本轮只做单文件**」——Netscape bookmark HTML 的批量导入导出不做。AgentMux 今天没有书签库，
  导进来无处安放。

## 2. 约束设计形状的发现

### 2.1 `@` 前缀缺陷不是附带的，它是贴图这条的前置条件

`terminal-path-link.ts:37` 的 `PATH_TOKEN` 把 `@` 同时放进了否定后顾和段字符类：

```
/(?<![\w./@~:-])((?:\.\.?\/|~\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+)(?::(\d+)(?::(\d+))?)?/g
```

后顾里的 `@` 只挡住「从一个 `@` 之后**重新起头**」（`foo@bar` 不会再从 `bar` 匹配一次），
挡不住「**从 `@` 本身起头**」。于是 `@src/foo.ts` 整体落进 Group 1，解析出的路径带着 `@`。
实测（`node` 直接跑这个正则）：

| 输入 | Group 1 |
|---|---|
| `@src/foo.ts` | `@src/foo.ts` |
| `@/Users/x/.agentmux/pasted/paste-1.png` | `@/Users/x/.agentmux/pasted/paste-1.png` |
| `node_modules/@types/node/index.d.ts` | `node_modules/@types/node/index.d.ts` |

第三行是修法的边界条件：scoped package 里的 `@` 在**段中**被吃掉，前面那个 `/` 在后顾集合里，
所以它从不作为起点。**因此只能摘掉「起头的那个 `@`」，不能把 `@` 从段字符类里整个拿掉**，
否则 `@types/` 会被切断。

这个缺陷与贴图直接咬合，而不是顺手修的第二件事。粘图之后走的链路是：
`ipc.ts:524` 把文件写到 `~/.agentmux/pasted/`（**在任何 workspace 之外**）→ 返回绝对路径 →
`composer-file-reference.ts` 的 `workspaceRelativePath` 对 workspace 外的路径**原样返回绝对形式** →
`appendFileReferences` 前面加 `@`，于是消息文本里是 `@/Users/x/.agentmux/pasted/paste-1.png`。

这个 token 今天之所以还能渲染成一个按钮，**正是因为 `@` 缺陷**：带着 `@` 它不以 `/` 开头，
于是 `resolveWorkspaceRelativePath` 走的是「相对路径」那条分支，原样放行。实测：

```
resolve('/Users/x/proj/foo', '@/Users/x/.agentmux/pasted/paste-1.png')
  = /Users/x/proj/foo/@/Users/x/.agentmux/pasted/paste-1.png   （落在 root 内 → 放行）
resolve('/Users/x/proj/foo', '/Users/x/.agentmux/pasted/paste-1.png')
  = /Users/x/.agentmux/pasted/paste-1.png                      （在 root 外 → 拒绝）
```

所以今天用户看到的那个按钮是**一个恒定打不开的按钮**：它指向 `<root>/@/Users/...`，必然 ENOENT。

**推论（这是本节的结论）**：把 `@` 修对之后，这个 token 会被 workspace 判定**正确地拒绝**，
于是退回纯文本——比今天的死按钮诚实，但仍然不是图。所以「修 `@`」与「认出贴图」必须在
同一条 Feature 里按这个顺序落地：先让 workspace 判定不再冒领它，再让贴图判定认领它。
两者不抢：一个拒绝，另一个接手。

### 2.2 贴图目录是一个应用自有的第二根，它不该挤进 workspace 判定

`resolveWorkspaceRelativePath` 的契约写在它的 docstring 里：返回 `openFile` 要的
**workspace 相对路径**。贴图在 workspace 之外，塞不进这个契约；把它改成「有时返回绝对路径」
会一路漂到 `openFile`。

所以贴图**不走文件引用那套检测**。它是一个独立的、更窄的判定：
「这个 token 是不是一张本应用自己写下的贴图」。它的形状是应用自有的
（`<home>/.agentmux/pasted/<名字>.<扩展名>`），所以判定可以精确，
而**读取 IPC 的信任边界正好与这个判定重合**——只允许读这一个目录。判定与边界同形，
是这条设计成立的原因，不是巧合。

### 2.3 贴图目录今天有两个写入点，读取点会是第三个

- `ipc.ts:524` — 粘贴图片
- `composer-screenshot.ts:9` — 截屏

两处各自 `join(home, '.agentmux', 'pasted')`。再加一个读取点就是三份手抄常量，而这三份
必须永远一致（读取点的白名单就是写入点的目标）。**先把它收成一个导出常量再写逻辑**。

### 2.4 CSP 把 `file:` 挡死，data URI 不是选择而是唯一解

`index.html:9` 是 `img-src 'self' data:`。已有先例：`browser-image.ts:57-63` 返回
`{ mimeType, dataUrl, width, height, byteLength }`，`ScreenshotEditor.tsx:247` 直接
`<img src={image.dataUrl}>`。新的读图 IPC 照抄这个形状，不发明第二种。

### 2.5 没有任何 IPC 读得到贴图的字节

`files.read` 返回 `FileDocument.content: string`（`workspace-files.ts:1019` 是
`bytes.toString('utf8')`），且 `localPathWithin` 把每一条读路径硬锁在 workspace root 内。
贴图在 workspace 外，`files:read` 会抛 `Path escapes the workspace root`。
**所以必须新增一条读取通路**，且它不能路由到 `WorkspaceFiles`——那套的根是 workspace，
而这里的根是贴图目录。两个根，两套判定，不要合并。

### 2.6 「查看源码」不是第二个 surface，是一个显示模式——但书签是跨 surface 的

本仓已有的「同一个文件两种看法」是 `editorRegionModes`（`store.ts:417`）：
`openFileDiff` **不创建第二个 surface**，它复用同一个 tab、同一个 document，只翻一个
per-region 的模式位（`EditorPane.tsx:458` 按它分叉渲染）。注释写得很清楚：
「Diff is a display mode of this file Region, not a separate tab」。

书签这条比它多一步：默认进 **Browser** surface，「查看源码」要回到 **file** surface。
这是跨 surface 的，`editorRegionModes` 那套模式位覆盖不到。**但不该为此新造 surface kind**——
`WORKBENCH_SURFACE_KINDS` 加一个成员会打红一长串穷尽性守卫
（`workbench-surface-kind-exhaustiveness.test.ts` 全渲染层 AST 扫描、十余处
`assertUnreachableSurface` 分叉），而收益只是「同一个路径的另一种看法」。

**取法**：`openFile` 已经有「不进 Monaco」的先例——目录那一条（读到 `status === 'directory'`
就去 reveal，不建 document）。书签按同一个位置分叉：读出来是书签文件就开 Browser。
「查看源码」则是同一个 `openFile` 带一个「强制按文本打开」的入参，走回既有的 Monaco 路径。
一个布尔入参，零新 surface kind。

### 2.7 `.webloc` 可以是二进制 plist，而 `files.read` 只给字符串

实测：`plutil -convert binary1` 产出的 `.webloc` 是 `bplist00` 开头的二进制。
`files.read` 返回 `string`，二进制过 `toString('utf8')` 会被破坏。

本机真实样本核对过 `.url`（`/Users/…/Desktop/*.url`）：`[InternetShortcut]\nURL=…`，
**LF 而不是 CRLF**，无 BOM，ASCII。`.webloc` 用 `plistlib` 生成、`plutil -lint` 判定为 OK 的
XML 形态就是 Finder 认的形态。

两条结论：
- **发射**一律发 XML plist（Finder 和别的浏览器都认，且是文本，写得进 `files.write`）。
  不发二进制——没有理由，且会把自己锁死在一个 `files.read` 读不回来的格式上。
- **解析**要能应付二进制。不引 plist 依赖：macOS 自带 `plutil -convert xml1 -o -` 能把
  二进制转成 XML，而 `runProcess`（`packages/core/src/process-runner.ts:27`）已经是本仓
  shell-out 的既有形状（`composer-screenshot.ts:12` 就这么用 `/usr/sbin/screencapture`）。
  `ponytail:` 这是「先按文本解析，失败再 shell 出去」的两段式，上限是多一次进程启动；
  真要常态化再考虑依赖。

### 2.8 写入只能落在 workspace 内

全仓 `showSaveDialog` **零命中**，没有原生保存对话框。`files.write` 经
`localMutablePathWithin` + realpath 双重锁在 workspace root 内。

所以「把当前页存成书签」落在 workspace 里。这不是妥协，是更好的选择：文件在资源管理器里看得见、
进得了版本控制、Agent 也读得到。**不为此新造一条能写到 workspace 外的特权通路**——那要新的
特权 handler 加原生对话框，两样今天都不存在，而收益只是存到桌面。

### 2.9 Finder 里双击不在本轮范围内

goal 里「存下来的文件必须能被 Finder 和其他浏览器直接打开」说的是**产物合法**——
Finder 双击交给系统默认浏览器，那本来就对，不需要我们做任何事。
「在 AgentMux 里打开书签走 AgentMux 的 Browser」才是用户那句「应该是默认 browser」的意思。

让 Finder 双击唤起 AgentMux 需要 `CFBundleDocumentTypes` 加 `app.on('open-file')`，
全仓零先例（`open-file`/`CFBundleDocumentTypes` 均零命中）。**不做**，也没人要求。

## 3. 落地形状

### A. 书签文件

**新纯模块 `apps/desktop/src/main/bookmark-file.ts`**，照 `browser-app-link.ts` 的形状：
不 import electron、无模块级副作用，判定可被单测直接质询。

- 扩展名成员收成一个导出元组（`schema-enum-ssot` 房规）。
- 解析：取出 URL；解析不了返回 `null`，不抛。
- 发射：给 URL 和标题，产出文本。

**存**：BrowserPane 工具栏第 6 个按钮。注意这会打红
`browser-toolbar.ts:54-57` 的双向精确性证明、`DEFAULT_CONFIG`、zod schema 和 mock —— 这是
**预期的连锁**，四处一起改才编译得过，正是那个设计要的效果。

**开**：`openFile` 里按目录分支的同一位置加一条。

**查看源码**：`openFile` 加一个「强制按文本」入参，Browser 工具栏上给入口。

### B. 对话贴图

顺序是承重的（见 §2.1）：

1. **先修 `@`**——只摘起头的那个，`@types/` 必须仍然完好。这是根因修法，
   `TerminalView` 与 `markdown-file-reference` 两个调用方一起受益。`@` 在现有测试里
   **零覆盖**，要补。
2. **收贴图目录常量**（见 §2.3），两个既有写入点改为引用它。
3. **读图 IPC**：只允许读贴图目录，返回 data URI，形状照抄 `browser-image.ts`。
   大小上限比照既有两处。
4. **渲染**：认出贴图引用，渲染 `<img>` 缩略图。
5. **放大**：`@radix-ui/react-dialog` 已在依赖里，`ConfirmationDialog.tsx` 就是本仓用它的既有形状。
   不手搓浮层。

## 4. 不做

- Netscape bookmark HTML 批量导入导出（用户本轮确认）。
- 网页 HTML 源码查看器——DevTools 已覆盖。
- Finder 双击唤起 AgentMux（§2.9）。
- 能写到 workspace 之外的保存通路（§2.8）。
- 新的 workbench surface kind（§2.6）。
- 二进制 plist 的发射（§2.7）。
