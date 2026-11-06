# 已知问题与坑

这份文档记录实机踩过的坑，避免下次重走一遍。

## ACP 连接

### 1. 模型选择不持久化，重连会退回 `deepseek-official`（最常见）

**症状**：连接页红字 `turn failed: llm-deepseek: no API key for provider route "deepseek-official"`，
她连上了却一句话都不说。

**操作步骤**（每次重连后都要做一遍）：

1. 右键鱼鱼 → 设置
2. 打开「连接 Agent」页（显示 `DeepSeek Harness · 已检测到` 那一页）
3. 往下找「模型与权限」，模型下拉有两组：

   ```
   DeepSeek              ← 不要选这组（走 official 路由，需要 API key）
     deepseek-v4-flash
   DeepSeek Account      ← 选这组
     DeepSeek-V4.1-Flash   ✅ 选它
     DeepSeek-V4-Pro
   ```

4. 选完看红字是否消失；消失即生效

**为什么每次都要重选**：模型选择没有被持久化，清会话绑定、重启鱼、改设置之后，新会话会退回 profile 的默认路由。
profile 里能改的只有「默认值」，改不动她客户端自己发的那份选择。

**试过但不可行的办法**：

- 把 profile 的 `llm-deepseek` 配上 `baseURL: http://127.0.0.1:15721/v1`（本地 CC Switch 代理）+ `apiKeyEnv`
  → provider 直接不可用，报 `turn failed: 未配置供应商`，已回滚
- 把 `agent-default-model` 改成 `deepseek-account` → 她客户端自己的选择会覆盖，无效

**现象**：清掉 `data/agent/sessions/*/dsh.json` 或重启鱼之后，新会话用 profile 默认路由；而 acp profile 默认的
`deepseek-official` 需要 `DEEPSEEK_API_KEY`，机器上没有 → 每一轮都 `turn failed: no API key`。

**临时解法**：在「连接 Agent → 模型与权限」里手动选 **DeepSeek Account** 组下的 `DeepSeek-V4.1-Flash`。
选完当轮立刻可用，但**下次重连还会退回去**。

**根治方向**：把 acp profile 的 `deepseek-official` 路由指到本地 CC Switch 代理（`http://127.0.0.1:15721/v1`，
token 用 `PROXY_MANAGED`），或者在 profile 里彻底禁掉 official 路由，只留 account。

### 2. `say` 只能通过 UI 的「连接 Agent」建立

`BigBlueFish.Mcp.exe` 是 `say` / `set_animation` 的实际提供者。它必须与鱼主进程有活的 IPC，
单独运行会报「蓝色大肥鱼内部工具未连接：请通过标准版的"连接 Agent"页面建立连接」。

所以：**改 `preferences.json` 里的 `AgentEnabled` 不够**，UI 那次握手才是桥的起点。

### 3. 工具清单在会话建立时装配

`tender_*` 工具装进 acp profile 之后，**已经存在的会话不会自动获得**。
必须清掉会话绑定（`data/agent/sessions/<hash>/dsh.json`）并重连，新会话才会带上。

验证办法：解压该会话日志，`grep tender_learning_state`——工具名出现在注册表里就说明带上了。

```powershell
$node -e "const z=require('node:zlib');const fs=require('node:fs');fs.writeFileSync('out.jsonl', z.zstdDecompressSync(fs.readFileSync(process.argv[1])))" <session.v4.jsonl.zstd>
```

## 心跳与心情

### 4. 情绪是「窗口平均」，极端值会互相抵消

24 小时 / 最近 12 条窗口里正负事件混在一起时，`emotion_context.label` 会变成「中性或混合」，
`moodOf()` 返回 null。此时 **共情信息仍然要写**（判断、怎么帮、问一句），只是语气不跟着变。
插件已经改成 `syncPersona(card, null)` 分支处理。

### 5. 本地模型对 persona 的遵从度有限

心情写在 persona 标记块里，本地 4B 模型会参考，但不保证严格照做。实测有效但不精确。
要精确控制语气，得走 ACP 让云端模型说。

### 6. 心情小窗曾经盖住鱼

小窗是置顶窗口，每 2 秒重绘一次，压在她身上时会闪一块黑。已改成：左下角、只在状态变化时重绘、开双缓冲。

## 环境

### 7. 本机 `python` 是应用商店空壳

`bili-duty` 的 MCP 服务默认用 `python`，会直接失败。已建 `C:\Users\Dell\.dsh\bili-duty\.venv`
并在 desktop profile 的 `dafeiyu-life` 配置里把 `pythonPath` 指过去。

### 8. 宿主进程里没有 `DSH_HOME` / `DSH_PROFILE_DIR`

插件里读这两个环境变量会拿到 `null`，绝对路径必须写进 bundle 配置。

### 9. 网络

`github.com` 与 PyPI 直连经常不通（000 / 超时），但 `api.github.com` 和国内镜像正常。
推送用重试循环，装依赖用 `-i https://pypi.tuna.tsinghua.edu.cn/simple`。
### 10. 工具报 403 `cross_learner_denied`

Tender 会校验「令牌所属学习者」与「被查对象」是否一致。工具早期用固定的 `actor_id` 换 token，
再用它去查别的 learner，就被 403 拒了。修法：**按被查 learner 单独换 token，并且 `actor_id` 用同一个 id**。

### 11. 把 official 路由改指本地代理会报「未配置供应商」

试过把 acp profile 的 `llm-deepseek` 配上 `baseURL: http://127.0.0.1:15721/v1` + `apiKeyEnv`，
结果 provider 直接不可用（`turn failed: 未配置供应商`）。**已回滚**，别重复这条弯路。
