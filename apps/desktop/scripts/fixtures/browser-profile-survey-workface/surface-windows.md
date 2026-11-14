# Survey 与 Recall 整面窗口验收

运行 `node apps/desktop/scripts/verify-browser-profile-survey-workface.mjs --case surface-windows --output .local/knowledge-surface-windows/product`。合同见[工作面的独立窗口](../../../../../docs/design/behavior/spaces-and-layout.md#工作面的独立窗口)和[整面窗口的呈现](../../../../../docs/design/presentation/spaces-and-layout.md#工作面的独立窗口)。

第一个隔离 Electron 进程从 Focus 右击 Survey，在主窗口 Recall 面内打开笔记窗口，使用分离的 Survey 访问测试网站，在 Recall 创建并编辑原 Note。随后从公共 CLI 再次打开两个目标并核对窗口身份。第二个进程从同一份已保存数据恢复窗口、网页、笔记与工作草稿，检查系统关窗保留 Focus、显式返回落到同一 Note。

截图调用当前产品的 `app.capture` 合成准确窗口及其原生网页层。逐张查看 `first-*.png` 和 `restart-recall-returned.png`，重点检查工作区是否填满、返回入口、窄短窗的工具与正文，以及网页是否真实显示。变异参数 `--mutation misroute-surface-menu` 将右键动作误导至 Recall，验收须在查找 Survey 窗口时失败，并记录误开的窗口。临时资料由本场景清理，输出保留窗口回执、原生输入轨迹和图片。

在已打开的笔记中，场景还会实际最小化 Recall，等系统与窗口回执同时确认隐藏，再恢复编辑面。随后从面包屑进入原 Notebook、重新打开原 Note，并从「Page sources」在已分离的 Survey 打开该笔记来源；主窗的 Focus 和 Work 选择须始终保留。来源数据经真实 Notebook 写入接口准备，点击、窗口导航、原生网页载入和原编辑器读取由产品完成。

`--mutation steal-main-surface` 会让分离窗口内的导航同步改写主窗。相同的 Notebook 面包屑点击必须使保持 Focus 的断言失败。

从来源页返回原网页时，公开 `app focus --surface survey --browser ID --region ID --input preserve` 必须在回执中区分主窗 Focus 与原 Survey 窗口的实际呈现。随后 `app focus --surface recall --input preserve` 定位原 Recall 窗口。两次导航都保留已选择的 Note 编辑器，检查窗口操作回执可确认没有新发原生聚焦请求。隔离应用按现有流程在后台启动，macOS 若未授予系统键盘焦点，回执须保留未确认状态。

顶边验收覆盖 Survey、Recall、整个 Tab 与单个 Region。场景通过 Survey 的新建 Tab 按钮在同一研究中准备两个真实标签，切回原网页，核对标签条和左侧窗口控件同高起步。宽窗、窄窗、折叠目录以及窄窗 Browser tools 的截图保留正文和来源。macOS 仅在已授予屏幕录制权限时按该实例的窗口 ID 截取一张双标签系统窗口，系统拖动手势不在后台自动验收范围内。

重启返回笔记后，场景分别按原 Workspace、Group、Tab、Region 打开两种空间窗口，核对原内容、文档标题、拖动区、返回控件，实点归还并检查原运行进程。`--mutation omit-recall-content-edge` 使 Recall 无法取得自己的窗口控件，真实原窗口的唯一 Return 断言应失败。
