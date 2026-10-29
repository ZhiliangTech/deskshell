# 贡献指南

先说清楚这个项目要什么、不要什么。

**要**：可验证、可撤销、可审计的电脑操作能力；一个能长出生态的协议。
**不要**：只有 demo 效果的脚本、绕过权限层的"捷径"、把模型塞进内核的改动。

## 环境

- Node.js 22+
- 文件场景：任意平台
- UI 场景：Windows（UIA 驱动）；macOS 驱动为实验性，见 `docs/drivers.md`

```bash
git clone <repo>
cd deskshell
node scripts/regress.ts      # 7 项自检，必须全绿
node scripts/build-docs.ts   # 生成文档站
```

没有 `npm install`——项目零第三方依赖，这是刻意的。

## 贡献一个 skill（最低门槛）

```bash
node scripts/new-skill.ts --name my-skill
```

然后只改 `plan()`。三条硬规则：

1. 每个动作都要有 `post` 断言；
2. 每个动作都要有 `undo`（不可撤销的请说明理由，并预期被内核拒绝）；
3. skill 里不准直接调系统 API，只能产出 `Action`。

提交前：

```bash
node apps/cli-demo/run.ts --skill packages/skills/my-skill/index.ts --mode preview
node apps/cli-demo/run.ts --skill packages/skills/my-skill/index.ts --mode apply --root .demo/downloads
node apps/cli-demo/run.ts --skill packages/skills/my-skill/index.ts --mode undo
```

## 贡献一个驱动

驱动只实现一个接口（`packages/core/src/types.ts` 里的 `UiDriver`）：

```ts
windows(); tree(ref, depth); invoke(ref, sel); click(ref, sel);
type(ref, sel, text); keys(ref, combo); focus(ref);
```

新平台请：

1. 新建 `packages/drivers/<platform>/`；
2. 实现接口，并补 `scripts/verify-driver.ts` 能识别的平台分支；
3. 在 `docs/drivers.md` 写清楚：已验证的能力、未验证的能力、已知限制。

**不要**为了跑通而在驱动里做权限判断——权限是内核的事。

## 改内核

内核的破坏性变更必须走 RFC（`rfcs/`），并满足：

- 现有 skill 的预览快照不发生变化，或提供迁移脚本；
- 回归套件全绿；
- CHANGELOG 写清楚迁移步骤。

## 提交信息

```
feat(skill): 按日期归档照片
fix(driver): 修复最小化窗口矩形为无穷大的问题
docs: 补充 macOS 验证步骤
```

## 行为准则

技术讨论可以很直接，对人不可以。人身攻击、歧视、骚扰，一次就移除。

## 许可

贡献即同意以 MIT 许可发布。
