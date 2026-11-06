/**
 * dafeiyu-heart —— 让每轮对话变成一次心跳。
 *
 * 链路：agent/inbox/claimed 记下本轮用户说了什么
 *      → agent/turn-stopping 截成摘要 + 哈希，POST Tender /heart/beat
 *      → 状态卡映射成 mood，交回大肥鱼自己的 createEmotionalState().update()
 *
 * 任何一步失败都只记日志，绝不打断对话。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_SUMMARY = 60
const LOG_FILE = 'D:/Tender/Tender-GitHub-Release/integrations/dafeiyu-heart/plugin.log'

function log(stage, detail = {}) {
  try {
    // 每轮都会写一行，超过 256 KiB 就从头开始，避免无限增长
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 256 * 1024) {
      writeFileSync(LOG_FILE, '')
    }
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), stage, ...detail }) + '\n')
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

function textOf(message) {
  const blocks = message?.content
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

function digest(text) {
  return 'sha256:' + createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function moodOf(card) {
  const emotion = card?.state?.emotion_context
  if (!emotion || emotion.label === '未观测') return null
  if (Number(emotion.confidence) < 0.2) return null
  const mood = {
    积极唤醒: 'curious',
    平稳积极: 'warm',
    紧张或高负荷: 'irritated',
    低能量: 'tired',
  }[emotion.label]
  if (!mood) return null
  const confidence = Number(emotion.confidence)
  return {
    mood,
    intensity: confidence >= 0.7 ? 3 : confidence >= 0.4 ? 2 : 1,
    source: 'main-session',
  }
}

function emotionalStatePath(config) {
  if (config.emotionalStateModule) return config.emotionalStateModule
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return null
  return path.join(profileDir, 'node_modules', 'dsh-dafeiyu-life', 'lib', 'emotional-state.mjs')
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const tenderUrl = (config.tenderUrl || process.env.TENDER_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
  const learnerId = config.learnerId || 'dafeiyu'
  const dataDir =
    config.dataDir || process.env.DAFEIYU_DATA_DIR || path.join(process.env.DSH_HOME || '', 'bili-duty')

  const pending = new Map()
  let tokenPromise = null

  const warn = (error) => {
    log('error', { message: String(error?.message || error) })
    console.warn('[dafeiyu-heart]', error?.message || error)
  }

  log('apply', {
    tenderUrl,
    learnerId,
    dataDir,
    profileDir: process.env.DSH_PROFILE_DIR || null,
    dshHome: process.env.DSH_HOME || null,
  })

  async function token() {
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const response = await fetch(`${tenderUrl}/auth/demo-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor_id: 'dafeiyu', role: 'learner', learner_id: learnerId }),
        })
        if (!response.ok) throw new Error(`demo-session ${response.status}`)
        return (await response.json()).token
      })().catch((error) => {
        tokenPromise = null
        throw error
      })
    }
    return tokenPromise
  }
  // 把 Tender 的状态卡写进人设：心情 + 为什么 + 该怎么帮 + 反思问题
  function syncPersona(card, update) {
    const file = config.personaFile
    if (!file || !existsSync(file)) return
    const labels = { joyful: '开心', curious: '好奇', warm: '温暖', calm: '平静', tired: '疲惫', sad: '低落', irritated: '烦躁' }
    const label = labels[update.mood] || update.mood
    const state = card?.state || {}
    const hypothesis = Array.isArray(state.hypotheses) && state.hypotheses.length
      ? state.hypotheses[0]
      : null
    const support = hypothesis?.support_hint ? String(hypothesis.support_hint) : ''
    const reflection = state.reflection_prompt ? String(state.reflection_prompt) : ''
    const summary = state.summary ? String(state.summary) : ''

    const lines = [
      '<!-- tender-mood:start -->',
      `【当前心情】${label}（${update.mood}），强度 ${update.intensity}。语气跟着这个心情走。`,
    ]
    if (summary) lines.push(`【Tender 的判断】${summary}`)
    if (support) lines.push(`【可以怎么帮她】${support}`)
    if (reflection) lines.push(`【可以问的一句】${reflection}`)
    lines.push(
      '【共情方式】先承认她的感受，再给一个最小的下一步；不评判、不追加任务、不贴标签。',
      '【边界】这是建模出来的状态假设，别说成诊断，也别说「我测出你有问题」。',
      '<!-- tender-mood:end -->',
    )
    const block = lines.join('\n')

    try {
      const text = readFileSync(file, 'utf8')
      const start = text.indexOf('<!-- tender-mood:start -->')
      const end = text.indexOf('<!-- tender-mood:end -->')
      const next = start >= 0 && end > start
        ? text.slice(0, start) + block + text.slice(end + '<!-- tender-mood:end -->'.length)
        : text.trimEnd() + '\n\n' + block + '\n'
      writeFileSync(file, next, 'utf8')
      log('persona', { mood: update.mood, hypothesis: hypothesis?.id || null, hasSupport: Boolean(support), patched: start >= 0 })
    } catch (error) {
      warn(error)
    }
  }

  async function beat(key) {
    const item = takePending(key)
    if (!item) {
      log('no-pending', { key, size: pending.size })
      return
    }

    const text = String(item.text || '').trim()
    if (!text) return

    try {
      const response = await fetch(`${tenderUrl}/heart/beat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({
          learner_id: learnerId,
          event: {
            kind: 'conversation',
            summary: text.slice(0, MAX_SUMMARY),
            evidence_hash: digest(text),
            attrs: { source: 'dafeiyu-heart-plugin', channel: 'dsh' },
          },
          consent_scopes: ['companion_support'],
        }),
      })
      if (!response.ok) throw new Error(`heart/beat ${response.status}`)

      const card = await response.json()
      const update = moodOf(card)
      log('beat', {
        events: card?.state?.state_snapshot?.event_count ?? null,
        label: card?.state?.emotion_context?.label ?? null,
        confidence: card?.state?.emotion_context?.confidence ?? null,
        mood: update?.mood ?? null,
        memory: card?.memory ?? null,
      })
      // 情绪可能算成「中性或混合」，共情信息照样要写；情绪只影响语气，不影响判断与建议
      if (!update) {
        syncPersona(card, null)
        log('persona', { mood: null, reason: 'neutral-emotion' })
        return
      }

      const modulePath = emotionalStatePath(config)
      if (!modulePath || !existsSync(modulePath)) {
        log('skip', { reason: 'emotional-state module missing', modulePath })
        syncPersona(card, update)
        return
      }

      const { createEmotionalState } = await import(pathToFileURL(modulePath).href)
      const state = createEmotionalState({ dataDir })
      const applied = state.update(update)
      const snapshot = state.snapshot()
      log('mood', { applied })
      syncPersona(card, { ...update, intensity: snapshot.intensity })
    } catch (error) {
      warn(error)
    }
  }

  // 两个事件里的 agent 标识不一定一致，按 key 取不到时退回最近一条（单用户场景足够）
  function takePending(key) {
    if (pending.has(key)) {
      const item = pending.get(key)
      pending.delete(key)
      return item
    }
    let newestKey = null
    let newest = null
    for (const [candidate, item] of pending) {
      if (!newest || item.at > newest.at) {
        newest = item
        newestKey = candidate
      }
    }
    if (newestKey) pending.delete(newestKey)
    return newest
  }

  const offClaim = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const key = agent?.id ?? agent?.sessionId ?? 'default'
    pending.set(key, { text: textOf(message), at: Date.now() })
    log('claim', { key, chars: textOf(message).length })
  })

  const offStop = ctx.on('agent/turn-stopping', ({ agent }) => {
    const key = agent?.id ?? agent?.sessionId ?? 'default'
    void beat(key)
  })

  return () => {
    offClaim?.()
    offStop?.()
  }
}
