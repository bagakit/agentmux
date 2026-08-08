# 本地文件预览与编辑调研

Feature: `f-24v8fec2k` / `local-file-preview-editors`

用户确认的需求：内置 Browser 支持本地文件预览；网页、图片、文本等能识别的常见格式
提供更合适的查看与编辑体验。以下方案是调研建议，尚不把具体图片编辑动作当作已确认范围。

## 现状

`browser-view-manager.ts` 的 `assertAllowedBrowserUrl` 只接受 HTTP、HTTPS 与空白页，
`normalizeBrowserUrl` 没有本地路径分支。因此这不是地址输入姿势问题，产品目前没有这条能力。
文本已经使用 Monaco (`EditorPane.tsx`)，应复用其文档、保存和 dirty 状态所有权。

## 成熟模式与来源

| 来源 | 已观察到的模式 | 对本项目的建议 |
| --- | --- | --- |
| VS Code [Custom Editors](https://code.visualstudio.com/api/extension-guides/custom-editors) 与 [Reopen With](https://code.visualstudio.com/updates/v1_44#_view-reopen-with) | 文件类型选择专用编辑器，用户可切回标准文本编辑；文本和二进制文档有不同所有权模型 | 保留文件身份，按格式选择表面，复用已有 Monaco 与保存通路，不把 Browser 变成另一套文档存储 |
| VS Code [Markdown preview association](https://code.visualstudio.com/updates/v1_63#_markdown-preview-editor) | 同一文件可以默认预览，也可以返回源码编辑 | 网页和 Markdown 可提供源码／预览切换；优先一键切换而非多层菜单 |
| Electron [Security](https://www.electronjs.org/docs/latest/tutorial/security#18-avoid-usage-of-the-file-protocol-and-prefer-usage-of-custom-protocols) | 官方建议受控自定义协议替代无约束的 file:// 访问 | 用户可输入本地路径或标准 file:// URL，但内部读取应有明确根目录范围；内容不能获得应用 preload 权限 |
| Electron [protocol](https://www.electronjs.org/docs/latest/api/protocol) | protocol.handle 负责资源响应；标准 scheme 能解析 HTML 的相对资源 URL | HTML/CSS/图片等相对资源走同一个受控路径入口，避免只打开主 HTML 却丢样式和图片 |

来源于 2026-09-10 查询的官方文档；没有把第三方插件能做的全部能力当成产品默认内置能力。

## 建议的首个可验收切片

先闭合“打开本地 HTML，正确显示同目录 CSS/图片，能切到源码并保存后刷新”。
随后接图片适配／缩放／尺寸信息与文本语言识别；图片的裁剪、旋转等写入操作需要明确范围，
不能用预览器冒充已完成的图片编辑器。未知或不可写格式如实显示能力边界。
采用已有 BrowserViewManager、文件读取所有者、Monaco 与工作台文件身份，
不先建设通用插件系统或另一个 HTTP 服务。

后续任务的反例至少覆盖：含空格和中文的路径、相对资源、失效文件、软链接越界、
未保存编辑切换预览、HTML 无应用 IPC 权限，以及未识别格式不被强行按文本写回。
本 Feature 保持 proposal，成熟模式调研完成后再安装具体格式任务计划；不阻塞已有版本安装。
