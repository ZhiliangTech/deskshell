<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# 常见问题

## 它是一个 agent 吗？

不是。内核里没有模型。deskshell 负责的是"安全地执行动作"这一层——预览、验证、撤销、审计。模型可以在它之上生成计划，内核不关心计划从哪来。

## 为什么不让 agent 直接控制鼠标？

因为那样没人能审计。在 deskshell 里，每个动作都有声明的能力、执行后的断言、以及撤销方式。出问题时你能精确说出哪一步失败、并把机器还原。

## 必须 Node 22.18+ 吗？

是。CLI 直接运行 TypeScript，类型擦除从 Node 22.18（或 23.6）才默认开启，`engines` 就写的这个范围。

## 某一步失败会发生什么？

任务停下：先撤掉失败动作自身已经产生的副作用（仅在它真的执行过时），再逆序回滚全部已完成步骤，失败原因进审计日志。不存在"改了一半"的状态。

## skill 能删我的文件吗？

`fs.delete` 存在，但 `undo: null` 的动作会被内核拒绝。删除通常表达为"移进 `.trash`"，那是可撤销的。如果你给某个 skill 授予了 `fs.write`，它确实能移动你的文件——这正是这个工具的用途。

## skill 能逃出我指定的目录吗？

不该能。路径被查两次：词法检查（拒绝 `..`）和真实路径检查（root 内指向外部的符号链接/junction 会被拒绝）。有一条名为 `symlink.escape` 的契约测试专门建了一个指向外部目录的 junction，断言写入被拒。

## 录制器是宏录制吗？

不是。它采样焦点、点击和新建窗口，然后产出带推断断言的 skill 草稿。点击类断言故意留空——只有人知道"这一下点成功了"意味着什么。

## 为什么包名是 `@ciceroyang/deskshell`？

因为部分网络访问不了 npmjs.com（网页 403，registry API 正常），无作用域的公共包暂时发不出去。GitHub Packages 现在可用；等 token 到位会补发无作用域的 `deskshell`。

## 重启后还能撤销吗？

能。撤销读的是磁盘上的 JSONL 审计日志，不是内存。`deskshell undo --task <id>` 是幂等的：第二次执行回滚 0 步。

## 现在还没覆盖什么？

- 没有 Linux 驱动（AT-SPI2）。
- macOS 坐标点击已实现并真机验证，但拖拽与右键菜单还没做。
- 录制器 300ms 轮询，只捕获左键。
- 外部副作用（HTTP 请求、已发出的邮件）不可撤销，这类动作必须显式标记，默认被拒。

## 怎么验证文档里的说法？

[STATUS.md](https://github.com/ciceroyang/deskshell/blob/main/STATUS.md) 里每条能力都配了命令与真实输出；`node scripts/regress.ts` 跑 24 项检查，含契约、快照、基准和三个新 skill。
