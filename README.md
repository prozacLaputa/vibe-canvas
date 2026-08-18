# Vibe Canvas

![Version](https://img.shields.io/badge/version-0.9.0-2f7df6)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Codex Plugin](https://img.shields.io/badge/Codex-Plugin-111827)
![License](https://img.shields.io/badge/license-MIT-22a06b)

简体中文 | [English](README_EN.md)

> 让 Codex 对话在右侧实时长成一张可筛选的思考画板。

![Vibe Canvas 界面](docs/screenshots/vibe-canvas-hero.png)

## 简介

Vibe Canvas 是一个本地优先的 Codex 插件。你继续在左侧正常和 Codex 对话，右侧 Browser 会自动展示结构化内容，并让每个三级结论按需展开第四级原文证据：

- 逐字保留的对话原文
- AI 归纳后的结构化理解
- 随对话持续生长的思维导图
- 默认折叠、点击可看的逐字原文证据

它不是一个需要再次输入、再次发送或手动保存的独立网站。HTML 页面只是 Codex 右侧的实时投影视图；输入、理解和推理仍然发生在当前 Codex 任务中。

适合用来做头脑风暴、方案推演、学习笔记、复盘、需求梳理，以及任何需要“边聊边看见结构”的思考过程。

## 功能特性

- **对话即输入**：左侧 Codex 是唯一文字入口，画板内没有第二套输入框。
- **原文可追溯**：每一轮用户输入逐字保留，不把 AI 改写冒充原文。
- **AI 自动 Pick**：新内容会被判断为 `picked`、`candidate` 或 `ignored`。
- **候选缓冲**：暂时无法判断的内容先等待后续语境，不急着进入结构。
- **人工最终决定**：每轮都有 Pick Checkbox；人工选择永久高于后续 AI 判断。
- **实时重组**：取消 Pick 后，对应内容立即退出结构和脑图，不会再次调用模型。
- **本地优先**：会话和主题偏好保存在当前 workspace 的 `.local/` 目录。
- **双主题**：亮蓝色默认主题与暖色主题可以即时切换并记住偏好。
- **增量同步**：每轮只读取紧凑投影并写入当前增量，避免反复回放全部对话。
- **跨轮聚合**：相同问题复用稳定 Topic，相同命题合并为一个 Claim 并累积多轮证据，不再把每句话简单追加成新节点。
- **交叉话题**：一个观点只保存一次，通过 primary / related Topic 和类型化关系连接，避免在多个分支重复出现。
- **保留真实冲突**：相反观点不会被当成重复删除，而是分别保留并标记为 `contradicts`。
- **有界投影**：默认最多展示 25 个节点，并保留 40 个最近活跃 Claim 用于下一轮匹配；摘要和证据索引也保持固定上限。
- **四级原文证据**：三级 Claim 显示 `原文 N`，点击或按 Enter / 空格展开逐字片段；原文必须能在对应用户输入中精确匹配，不能由 AI 编造。

## 截图

### Pick 已选与未选

左侧为绿色已选状态，右侧为灰色未选状态；取消后结构和脑图会同步更新。

![Pick 状态](docs/screenshots/vibe-canvas-pick-states.png)

## 环境要求

- Codex Desktop，且支持本地 Plugin、Skill、MCP Server 和右侧 Browser
- Node.js 20 或更高版本
- 可用的 `codex` CLI

当前版本在 macOS 上完成开发与验收。

## 安装

直接把 GitHub 仓库注册为 Codex Marketplace，再安装其中的插件：

```sh
codex plugin marketplace add prozacLaputa/vibe-canvas
codex plugin add vibe-canvas@vibe-canvas --json
```

确认安装状态：

```sh
codex plugin list --json
```

安装或升级后建议新建一个 Codex 任务，让 Skill 和 MCP 工具完成重新发现。

## 使用

在新的 Codex 任务中输入：

```text
使用 $vibe-canvas 打开一个思考画板
```

随后正常对话即可：

1. Codex 在右侧打开 Vibe Canvas。
2. 每轮回答前，当前对话会把本轮原文和结构增量同步到画板。
3. AI 自动选择明确有价值的内容，并把不确定内容放入候选缓冲。
4. 你可以在原文区点击 Pick，随时决定某轮是否进入结构与脑图。
5. 右上角 Switch 可切换蓝色与暖色主题。
6. 点击脑图中的三级要点，可展开或收起第四级逐字原文。

画板激活范围只限当前 Codex 任务；普通任务不会被自动接管。

## 原理

```mermaid
flowchart LR
    U[左侧正常对话] --> C[当前 Codex 任务]
    C -->|读取紧凑投影| M[本地 MCP Server]
    C -->|写入原文与类型化概念操作| M
    M --> J[本地 Session JSON]
    M --> R[Concept Graph Reducer]
    R --> J
    J -->|revision 变化| B[右侧 Browser 投影]
    B -->|Pick / 主题 PATCH| J
```

核心由三部分组成：

1. **Skill 负责时机与语义判断**：显式打开后，每轮通过 `vibe_canvas_get_projection` 读取 canonical Topic 和近期 Claim，再判断当前表达应该复用、合并、连接还是拆分。不会启动第二个 Codex 会话，也不会伪造用户消息。
2. **MCP Server 负责确定性状态**：Node.js 进程提供 MCP 工具和仅监听 `127.0.0.1` 的本地 HTTP API。Reducer 负责稳定 ID、规范化精确去重、Pick 溯源、跨主题关系、有界投影，以及校验每条 `sourceQuote` 确实来自本轮用户原文，并把完整 session 持久化为 JSON。
3. **Browser 负责投影与筛选**：页面约每 900 ms 检查内部 revision，只在状态变化时重绘。Pick、主题切换和原文展开直接在本地完成，不调用模型、不消耗额外 Token。

语义同义改写由当前 Codex 判断；服务端只对规范化后完全相同的问题或观点提供确定性兜底，因此不会虚假承诺任意改写都能 100% 自动合并。聚合范围是同一个 Canvas session，不会跨不同 Codex 任务自动合并。

Token 主要来自每轮一次紧凑结构读取和一次小型增量写入。画面限制为 25 个节点、匹配索引限制为 40 个近期 Claim；Codex 的紧凑投影只返回证据数量与最近 3 个来源 ID，不重复携带原文。逐字证据只发给本地 Browser，默认展示最近 5 条，完整溯源留在本地 JSON。浏览器轮询、主题切换、人工 Pick 和原文展开都是纯本地操作。

默认数据位置：

```text
<workspace>/.local/vibe-canvas-demo/sessions/<session-id>.json
<workspace>/.local/vibe-canvas-demo/preferences.json
```

## 快捷键

聚焦带 `原文 N` 的三级要点后，按 Enter 或空格可以展开 / 收起第四级原文。其他操作使用 Codex 对话和画板中的 Pick / 主题控件即可。

## 开发

```sh
npm test
```

33 项行为测试与浏览器视觉测试覆盖打开画板、增量同步、AI Pick、候选复判、人工覆盖、主题偏好、状态恢复、跨轮去重、交叉关系、逐字证据校验、默认折叠、鼠标和键盘展开、12 轮聚合回放和 100 轮证据边界。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 prozacLaputa
