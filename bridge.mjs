#!/usr/bin/env node
/**
 * dafeiyu-heart bridge：把一次事件送进 Tender 算出心智状态，再按大肥鱼自己的
 * 情绪状态接口写回去（不直接改 JSON 文件，避免绕过它的衰减与校验）。
 *
 * 用法：
 *   node bridge.mjs --learner yuyu_live --kind conversation \
 *        --summary "主人今天在改零基础教学" --hash sha256:demo \
 *        [--data-dir <目录>] [--dry-run]
 *
 * 环境变量：
 *   TENDER_URL     默认 http://127.0.0.1:8080
 *   TENDER_TOKEN   Bearer token；缺省时用 /auth/demo-session 走本地开发登录
 *   DAEFEIYU_PLUGIN  dsh-dafeiyu-life 包目录
 */
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

const TENDER_URL = process.env.TENDER_URL || 'http://127.0.0.1:8080'
const PLUGIN_DIR =
  process.env.DAEFEIYU_PLUGIN ||
  'C:/Users/Dell/.dsh/profiles/desktop/node_modules/dsh-dafeiyu-life'
const DEFAULT_DATA_DIR = 'C:/Users/Dell/.dsh/bili-duty'

function parseArgs(argv) {
  const out = { dataDir: DEFAULT_DATA_DIR, dryRun: false }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    const next = () => argv[++i]
    if (key === '--learner') out.learner = next()
    else if (key === '--kind') out.kind = next()
    else if (key === '--summary') out.summary = next()
    else if (key === '--hash') out.hash = next()
    else if (key === '--data-dir') out.dataDir = next()
    else if (key === '--valence') out.valence = Number(next())
    else if (key === '--arousal') out.arousal = Number(next())
    else if (key === '--dry-run') out.dryRun = true
    else throw new Error(`未知参数: ${key}`)
  }
  for (const required of ['learner', 'kind', 'summary', 'hash']) {
    if (!out[required]) throw new Error(`缺少 --${required}`)
  }
  return out
}

async function tenderToken() {
  if (process.env.TENDER_TOKEN) return process.env.TENDER_TOKEN
  const response = await fetch(`${TENDER_URL}/auth/demo-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actor_id: 'yuyu_bridge',
      role: 'learner',
      learner_id: 'yuyu_bridge',
    }),
  })
  if (!response.ok) throw new Error(`demo-session ${response.status}`)
  const data = await response.json()
  return data.token
}

const MOOD_BY_LABEL = {
  积极唤醒: 'curious',
  平稳积极: 'warm',
  紧张或高负荷: 'irritated',
  低能量: 'tired',
}

function intensityFor(confidence) {
  if (confidence >= 0.7) return 3
  if (confidence >= 0.4) return 2
  return 1
}

async function beat({ learner, kind, summary, hash, valence, arousal, token }) {
  const response = await fetch(`${TENDER_URL}/heart/beat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      learner_id: learner,
      event: {
        kind,
        summary,
        evidence_hash: hash,
        attrs: { source: 'dafeiyu-bridge' },
        ...(Number.isFinite(valence) ? { valence } : {}),
        ...(Number.isFinite(arousal) ? { arousal } : {}),
      },
      consent_scopes: ['companion_support'],
    }),
  })
  if (!response.ok) throw new Error(`heart/beat ${response.status}: ${await response.text()}`)
  return response.json()
}

/**
 * 把 Tender 的状态卡映射成大肥鱼的情绪更新。
 * 置信度不足时返回 null —— 宁可不动，也不要凭空造情绪。
 */
export function toMoodUpdate(card) {
  const emotion = card?.state?.emotion_context
  if (!emotion || emotion.label === '未观测') return null
  if (Number(emotion.confidence) < 0.2) return null
  const mood = MOOD_BY_LABEL[emotion.label]
  if (!mood) return null
  return {
    mood,
    intensity: intensityFor(Number(emotion.confidence)),
    source: 'main-session',
    summary: `tender:${emotion.label}`,
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const token = await tenderToken()
  const card = await beat({ ...args, token })
  const update = toMoodUpdate(card)

  const results = {
    heart: {
      event_id: card.event_id,
      summary: card.state?.summary,
      confidence: card.state?.confidence,
      memory: card.memory,
    },
    mood_update: update,
  }

  if (!update) {
    results.emotion = { applied: false, reason: 'insufficient_emotion_evidence' }
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (args.dryRun) {
    results.emotion = { applied: false, reason: 'dry_run' }
    console.log(JSON.stringify(results, null, 2))
    return
  }

  const modulePath = path.join(PLUGIN_DIR, 'lib', 'emotional-state.mjs')
  const { createEmotionalState } = await import(new URL(`file:///${modulePath.replace(/\\/g, '/')}`))
  const state = createEmotionalState({ dataDir: args.dataDir })
  const before = state.snapshot()
  const applied = state.update(update)
  const after = state.snapshot()

  results.emotion = {
    applied: Boolean(applied?.ok),
    before: { mood: before.mood, intensity: before.intensity },
    after: { mood: after.mood, label: after.label, intensity: after.intensity },
  }
  console.log(JSON.stringify(results, null, 2))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }))
  process.exitCode = 1
})
