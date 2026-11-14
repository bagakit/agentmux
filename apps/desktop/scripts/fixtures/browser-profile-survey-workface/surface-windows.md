# Survey 与 Recall 整面窗口验收

运行 `node apps/desktop/scripts/verify-browser-profile-survey-workface.mjs --case surface-windows --output .local/knowledge-surface-windows/product`。合同见[工作面的独立窗口](../../../../../docs/design/behavior/spaces-and-layout.md#工作面的独立窗口)和[整面窗口的呈现](../../../../../docs/design/presentation/spaces-and-layout.md#工作面的独立窗口)。

第一个隔离 Electron 进程从 Focus 右击 Survey，在主窗口 Recall 面内打开笔记窗口，使用分离的 Survey 访问测试网站，在 Recall 创建并编辑原 Note。随后从公共 CLI 再次打开两个目标并核对窗口身份。第二个进程从同一份已保存数据恢复窗口、网页、笔记与工作草稿，检查系统关窗保留 Focus、显式返回落到同一 Note。

截图调用当前产品的 `app.capture` 合成准确窗口及其原生网页层。逐张查看 `first-*.png` 和 `restart-recall-returned.png`，重点检查工作区是否填满、返回入口、窄短窗的工具与正文，以及网页是否真实显示。变异参数 `--mutation misroute-surface-menu` 将右键动作误导至 Recall，验收须在查找 Survey 窗口时失败，并记录误开的窗口。临时资料由本场景清理，输出保留窗口回执、原生输入轨迹和图片。
