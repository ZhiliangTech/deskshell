## 这个 PR 做了什么

<!-- 一句话说明；关联 issue 请写 "closes #123" -->

## 类型

- [ ] 新 skill
- [ ] 新驱动 / 驱动修复
- [ ] 内核变更（需要 RFC 链接）
- [ ] 文档

## 自检

- [ ] `node scripts/regress.ts` 全绿
- [ ] 新增/修改的 skill 跑过 preview → apply → undo
- [ ] 每个 Action 都有 `post` 断言
- [ ] 每个 Action 都有 `undo`（不可撤销的已说明理由）
- [ ] 没有在 skill 里直接调用系统 API
- [ ] 内核变更附了迁移说明

## 风险

<!-- 这个改动最坏会导致什么？怎么回滚？ -->
