# dafeiyu-heart

> 给大肥鱼装一颗 Tender 心脏。

**最新更新 / Latest update · 2026-11-06**

首个可用版本：每轮对话结束自动打一次 Tender 心跳，把得到的心智状态映射成大肥鱼自己的情绪并写回;
附带一个手动 bridge 和一个 Rust 记忆边车说明。本地已实测跑通。

## 这是什么

`dsh-dafeiyu-life`（大肥鱼）有自己的情绪、记忆和人格层。这个仓库不替换它，只做两件事：

1. **每轮对话 → 一次心跳**：把本轮消息截成摘要 + 哈希，交给 Tender 算心智化状态；
2. **状态 → 心情**：把状态卡映射成 `mood/intensity`，通过大肥鱼自己的 `createEmotionalState().update()`
   写回，走它的衰减与校验，不直接改 JSON。

## 结构

```
plugin/                 DSH 插件（@local/dafeiyu-heart），每轮自动打点
bridge.mjs              手动打点：node bridge.mjs --learner ... --summary ...
scripts/start-services.ps1  一键起 Tender(8080) + 记忆边车(8090)
docs/ARCHITECTURE.md    链路、数据契约、降级规则
```

配套但不在本仓库：`daoql-edu-serve`（Rust 记忆边车）与 `Tender-Product`（`/heart/beat` 端点）。

## 装

```powershell
# 1. 起依赖服务（Tender 与记忆边车）
.\scripts\start-services.ps1

# 2. 装插件
plugin_manager install_bundle  target: <本仓库绝对路径>\plugin
```

插件配置在 `plugin/cordis.patch.yml`，四个键：`tenderUrl` / `learnerId` / `dataDir` / `emotionalStateModule`。
**注意**：宿主进程里没有 `DSH_PROFILE_DIR`、`DSH_HOME`，路径必须写绝对路径。

## 验证

跑一轮带情绪的对话，然后看两处：

```powershell
# Tender 侧：事件数、情绪标签
curl "http://127.0.0.1:8080/heart/state/dafeiyu" -H "Authorization: Bearer <token>"

# 鱼侧：心情文件
Get-Content "$env:DSH_HOME\bili-duty\life-memory\emotional-state.json"
```

插件日志：`plugin.log`（每轮一行，超过 256 KiB 自动清空）。

## 边界

- 只传**摘要（≤60 字）与哈希**，原始对话不落库；
- 情绪置信度 < 0.2 或标签为「未观测」时**不更新心情**，宁可不动也不造情绪；
- Tender 或边车不可用时只降级，不阻断对话，也不伪造状态。

License: MIT.
