# 别人的工具，我们的数字

R0 只在作者机器上成立就不值得引用。这一页说清两件事：**怎么把我们的数字搬到别的环境复算**，以及**怎么把别人的工具放到同一把尺子下**。

## 一、换台机器复算（现在就能做）

```bash
R0_SSH_HOST=your-box R0_SSH_USER=root node scripts/r0-remote.ts
```

它把仓库打包传过去，在对方机器上跑：

```
→ 跑文件面 R0 … R0 逐字节还原 100% / 全部撤销 100% / 全部入账 100%
→ 跑 UI 面 R0 … R0-UI 状态归零 100%
```

e2b / daytona / trycua 的机器都行——只要你能 ssh 进去。**贴结果时必须写清机器和 node 版本**，只写一个百分比等于没跑。

没有机器？`--print` 看看它打算做什么，不连。

## 二、把别人的工具放进同一个基准（需要你填 4 个空）

`scripts/r0-adapter-template.ts` 是给被测工具用的适配器骨架：

```ts
export function createAdapter(): R0Adapter {
  return {
    apply(scenario) { /* 用它的 API 执行这批动作 */ },
    undo(scenario)  { /* 调它自己的撤销 */ },
    journalLines()  { /* 它能导出多少条审计记录；没有就 0 */ },
    snapshot()      { /* 状态快照 */ },
  };
}
```

写好后：

```bash
node scripts/recovery-bench.ts --adapter ./scripts/r0-adapter-e2b.ts
```

基准会拿同一批场景（嵌套写、移动覆盖、文件夹分类、移进新目录；UI 侧还有 move/type/invoke）去跑，然后给出它自己的 R0。

### 这个基准会当场揭穿三种作弊

| 作弊方式 | 基准怎么发现的 |
| --- | --- |
| 在 `undo` 里自己 `rm -rf` 重建目录 | 那不是它的撤销，是你的——`journalLines` 会是 0，rollback 率对不上 |
| 把 `journalLines` 写成动作条数 | 审计记录和动作条数是两件事；`r0-negative-test.ts` 就是拿这个当反例钉住的 |
| 只跑成功场景 | 每个场景都在第 1..N 步强制注入失败；跳过注入就等于没跑 |

这也解释了为什么 `scripts/r0-adapter-naive.ts` 会诚实地拿到 0/0/0——**一个永远都过的基准是广告，不是测量**。

## 三、三个候选，各自缺什么

| 工具 | 拿到能跑的状态需要 | 现在的状态 |
| --- | --- | --- |
| **e2b** | `E2B_API_KEY` + 一个 template；动作走它 SDK 的 fs API | 未跑（缺 key） |
| **daytona** | workspace + API token | 未跑（缺 token） |
| **trycua** | 一台 macOS 机器（它编排的是真 macOS 虚拟机） | 未跑（缺机器） |
| **你自己的 Docker** | `docker run -v $PWD:/w -w /w node:22` | 可以用 `r0-remote.ts` 的 docker 变体直接跑 |

一句话：**这四个里任何一个跑通之前，R0 只是"在 Windows 上和 Mock 驱动上成立"**。文档里也是这么写的，没有拔高。
