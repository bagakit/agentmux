# Leader Topic floating click review

## 问题

悬浮状态的 Leader Topic 头像在普通点击后必须打开同一个固定浮窗，并让标题栏、Topic 内容和 composer 可交互。拖动手势才改变坐标并取消点击；点击不能被拖动容器、阈值判断或状态同步吞掉。

## 约束

- 只修通用的 pointer/click 与浮窗可见性行为，不恢复 Default Session 命名或第二套 Topic。
- `launcher:leader`、浮窗状态、焦点返回和持久布局保持原有事实来源。
- 变异固定 Topic 绑定或打开事件必须让行为/契约测试变红；入口必须继续由 App 和浮窗生产调用。

**Review status: approved.**
