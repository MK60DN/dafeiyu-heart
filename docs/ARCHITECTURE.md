# 架构

## 一次心跳

```
用户一轮对话
  │
  ├─ agent/inbox/claimed   → 插件记下本轮文本（仅内存，不落盘）
  │
  └─ agent/turn-stopping
        ├─ 摘要 ≤60 字 + sha256(前 16 位)
        ├─ POST Tender  /heart/beat        （8080）
        │     ├─ 落事件库（摘要 + 哈希）
        │     ├─ 心智化状态卡（24 小时 / 最近 12 条窗口）
        │     └─ POST 记忆边车 /being      （8090，可选，失败降级）
        └─ 状态卡 → mood/intensity
              └─ createEmotionalState().update()  →  鱼的情绪文件
```

## 数据契约

**心跳请求**

```json
{
  "learner_id": "dafeiyu",
  "event": {
    "kind": "conversation",
    "summary": "前 60 个字符",
    "evidence_hash": "sha256:xxxxxxxxxxxxxxxx",
    "attrs": { "source": "dafeiyu-heart-plugin", "channel": "dsh" }
  },
  "consent_scopes": ["companion_support"]
}
```

**状态卡（节选）**：`state.emotion_context = { valence, arousal, label, confidence }`，
`state.state_snapshot = { mastery, jol_bias, hesitation, arrangement_fit, event_count }`，
`boundary` 固定说明「这是状态假设，不是诊断」。

**记忆边车**：`POST /being {name, def, summary, attrs, embedding}` → `{id}`，
图与关系在 DaoQL-Edu，动态属性与向量在边车自己的 redb。

## 映射规则

| Tender 标签 | 大肥鱼 mood |
|---|---|
| 积极唤醒 | curious |
| 平稳积极 | warm |
| 紧张或高负荷 | irritated |
| 低能量 | tired |
| 未观测 / 中性或混合 | 跳过 |

强度：`confidence ≥ 0.7 → 3`，`≥ 0.4 → 2`，否则 `1`；置信度 `< 0.2` 直接跳过。

## 降级

| 故障 | 行为 |
|---|---|
| Tender 不通 | 本轮不打点，只记日志；对话不受影响 |
| 记忆边车不通 | 心跳仍成功，`memory.degraded = true` |
| 情绪模块缺失 | 跳过心情写入，记 `skip` 日志 |
| 情绪证据不足 | 不更新心情，保持原状 |

## 已知取舍

- 情绪按**时间 + 条数**滑动窗口，而非全历史平均：否则一次负面事件会把之后很久的心情拖住。
- 摘要截断在 60 字：既够情绪推断，又避免把原文搬进存储。
- 插件不读 `DSH_PROFILE_DIR`（宿主里为空），路径全部走配置。
