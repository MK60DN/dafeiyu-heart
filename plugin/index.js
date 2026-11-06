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
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_SUMMARY = 60
const LOG_FILE = 'D:/Tender/dafeiyu-heart/plugin.log'

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

  async function beat(key) {
    const item = pending.get(key)
    if (!item) return
    pending.delete(key)

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
      if (!update) return

      const modulePath = emotionalStatePath(config)
      if (!modulePath || !existsSync(modulePath)) {
        log('skip', { reason: 'emotional-state module missing', modulePath })
        return
      }

      const { createEmotionalState } = await import(pathToFileURL(modulePath).href)
      const applied = createEmotionalState({ dataDir }).update(update)
      log('mood', { applied })
    } catch (error) {
      warn(error)
    }
  }

  const offClaim = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const key = agent?.id ?? agent?.sessionId ?? 'default'
    pending.set(key, { text: textOf(message) })
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
