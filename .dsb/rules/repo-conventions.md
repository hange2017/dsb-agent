# 仓库开发约定(示例规则)

本项目规则目录:`.dsb/rules/`(项目级)+ `~/.dsb/rules/`(用户级)。每个 `.md` 文件的内容会注入系统提示词的「项目规则」段,作为行为约束。

以下为示例,可按需增删文件。

## 提交信息

- 用中文,格式 `type(scope): 简述`,如 `feat(chat): 支持 /compact`、`docs: 同步验收状态`。
- `type` 用 `feat` / `fix` / `docs` / `refactor` / `test`,不要用 `update` / `misc` 等模糊词。
- 一个提交只做一件事;不要夹带无关改动。

## 改动验证

- 每次实现必须跑 `npm test` 全绿,再跑 `npm run compile`(或 `npx tsc --noEmit`)确认构建通过,才能声称完成。
- 新功能先写设计到 `.dsb/specs/`,较大改动写实现计划到 `.dsb/plans/`。
- 完成的功能同步更新 `.dsb/docs/project-overview.md` 的能力清单与状态。

## 依赖

- 优先用 Node/VS Code 标准能力或已有依赖;引入新 npm 依赖前先说明理由。
- 引擎层代码(src/ 下非 webview 部分)不直接依赖 `vscode` 模块,便于单测。
