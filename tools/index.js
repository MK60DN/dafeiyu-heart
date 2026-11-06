/**
 * tender-tools —— 把 Tender 的产品能力暴露成 Agent 工具。
 *
 * 装上之后，大肥鱼的 Agent 在 acp profile 里直接拥有这些工具：
 *   tender_learning_state / tender_mentalization / tender_timeline
 *   tender_fixed_agents / tender_agent / tender_knowledge_search
 *
 * 只读为主；tender_agent 会调用 Tender 已有的专家 Agent 接口（受 Tender 自己的授权约束）。
 */

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function jsonOutput(description) {
  return {
    schema: { type: 'object', additionalProperties: true, description },
    render: (_args, value) => text(value),
  }
}

export const name = 'tender-tools'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const baseUrl = (config.baseUrl || 'http://127.0.0.1:8080').replace(/\/$/, '')
  const learnerId = config.learnerId || 'yuyu'
  const actorId = config.actorId || learnerId

  // 每个学习者一个会话 token：Tender 会校验「令牌所属学习者」与「被查对象」一致，
  // 用 A 的身份查 B 会被 403 cross_learner_denied。
  const tokens = new Map()

  function token(learner) {
    if (!tokens.has(learner)) {
      const promise = (async () => {
        const response = await fetch(`${baseUrl}/auth/demo-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor_id: learner, role: 'learner', learner_id: learner }),
        })
        if (!response.ok) throw new Error(`Tender 登录失败：${response.status}`)
        const data = await response.json()
        return data.token
      })().catch((error) => {
        tokens.delete(learner)
        throw error
      })
      tokens.set(learner, promise)
    }
    return tokens.get(learner)
  }

  async function call(path, { method = 'GET', body, auth = true, learner = learnerId } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (auth) headers.Authorization = `Bearer ${await token(learner)}`
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Tender ${path} 返回 ${response.status}：${raw.slice(0, 300)}`)
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  const learnerArg = {
    learner_id: {
      type: 'string',
      description: `学习者 id，默认 ${learnerId}`,
    },
  }

  function learnerOf(args) {
    return args.learner_id || learnerId
  }

  ctx.tools.register({
    name: 'tender_learning_state',
    description: '读取 Tender 里某个学习者的当前状态：知识结构、元认知与 JOL 偏差、掌握度等。用于了解主人现在的学习处境。',
    parameters: learnerArg,
    output: jsonOutput('Tender 学习者状态'),
    async execute(args) {
      return call(`/tender/state/${encodeURIComponent(learnerOf(args))}`, { learner: learnerOf(args) })
    },
  })

  ctx.tools.register({
    name: 'tender_mentalization',
    description: '读取 Tender 的心智化状态卡：一句话结论、置信度、几条假设与支撑证据、可以怎么帮、反思问题。这是产品里给用户看的那张卡。',
    parameters: learnerArg,
    output: jsonOutput('心智化状态卡'),
    async execute(args) {
      return call(`/learner/mentalization/${encodeURIComponent(learnerOf(args))}`, { learner: learnerOf(args) })
    },
  })

  ctx.tools.register({
    name: 'tender_timeline',
    description: '读取 Tender 的心智化时间线：认知与情绪时间点、状态变化、支持—反思—结果链。用于回答「这周怎么样」这类问题。',
    parameters: learnerArg,
    output: jsonOutput('心智化时间线'),
    async execute(args) {
      return call(`/learner/mentalization/timeline/${encodeURIComponent(learnerOf(args))}`, { learner: learnerOf(args) })
    },
  })

  ctx.tools.register({
    name: 'tender_fixed_agents',
    description: '列出 Tender 里始终可用的固定辅助 Agent（心智化陪伴、认知情绪调节、反思教练、家庭桥接、安全保护）。',
    parameters: {},
    output: jsonOutput('固定辅助 Agent 列表'),
    async execute() {
      return call('/agents/fixed')
    },
  })

  ctx.tools.register({
    name: 'tender_agent',
    description: '调用一个 Tender 专家 Agent，把任务交给它并拿到回复。agent_id 来自 tender_fixed_agents 或市场列表。',
    parameters: {
      agent_id: { type: 'string', required: true, description: '要调用的 Agent id' },
      message: { type: 'string', required: true, description: '交给它的话或任务' },
    },
    output: jsonOutput('专家 Agent 的回复'),
    async execute(args) {
      return call(`/agents/${encodeURIComponent(args.agent_id)}/invoke`, {
        method: 'POST',
        body: { message: args.message, learner_id: learnerOf(args) },
        learner: learnerOf(args),
      })
    },
  })

  ctx.tools.register({
    name: 'tender_knowledge_search',
    description: '在 Tender 的知识库里搜索知识点，返回节点、学科与出处。',
    parameters: {
      q: { type: 'string', required: true, description: '关键词' },
      limit: { type: 'number', description: '返回条数，默认 10' },
    },
    output: jsonOutput('知识库搜索结果'),
    async execute(args) {
      const limit = Number(args.limit) || 10
      return call(`/knowledge/search?q=${encodeURIComponent(args.q)}&limit=${limit}`)
    },
  })
}
