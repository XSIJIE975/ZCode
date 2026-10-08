# 会话统计信息条（SessionStatsBar）

## 背景

输入卡片顶部的统计条：轮数 / 步数 / 上一轮与平均 tps / 累计输入输出 token /
客户端签名徽标 + 配置齿轮。数据双源：live 部分来自 session-debug 快照
（处理中 1s / 空闲 5s 刷新），持久部分来自 SQLite model_usage 聚合
（`useTaskUsageStats`）。挂载链：`SessionPane → ConversationComposer →
ChatPromptEditor` 的 `statsBar` 槽位。

## 规则

- **无数据不渲染**：轮数、输入、输出 token 全为 0 且无客户端签名状态时，
  整条不渲染——**包括容器与底部分隔线**。新会话发出第一条消息、agent 首轮
  尚未产生任何数据时，输入卡片不得出现空的顶栏外壳。
- **容器归属**：顶栏容器（负边距抵消卡片 p-3、border-b 分隔线）由
  `SessionStatsBar` 自渲染；`ChatPromptEditor` 的 `statsBar` 槽位只透传
  ReactNode，**不对元素做真值判断包壳**——React 元素对象恒为真值，
  `statsBar ? <容器/> : null` 会因子组件内部返回 null 而渲染出空容器
  （2026-10-08 修复的原始缺陷：新会话等待首轮响应时输入框上方出现空壳条）。
- 数据口径（main_turn 为主、子代理独立）、窄窗口渐进精简（容器查询
  `<720px` / `<520px`）与配置面板行为沿用既有实现，见组件头注释。

## 验收场景

1. 新会话发送第一条消息、agent 尚未产生 turn/token 数据：输入卡片顶部无空壳条。
2. 首轮数据到达（live 快照或落库）或出现签名状态：顶栏出现，样式与修复前一致
   （分隔线通到卡片左右边缘、顶部圆角由卡片 overflow-hidden 裁切）。
3. 配置面板关闭全部数据段且无签名状态：同场景 1，不渲染空条。
4. 无 sessionId（未建会话）：不渲染。
