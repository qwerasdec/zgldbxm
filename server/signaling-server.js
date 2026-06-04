import dotenv from 'dotenv'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { Server } from 'socket.io'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dotenvResult = dotenv.config({ path: path.join(__dirname, '..', '.env') })
// Windows 环境下可能存在同名空环境变量导致 dotenv 不覆盖，这里强制以 .env 为准
if (dotenvResult.parsed) {
  for (const [key, value] of Object.entries(dotenvResult.parsed)) {
    process.env[key] = value
  }
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001
const AI_BASE_URL = (process.env.AI_BASE_URL ?? 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
const AI_MODEL = process.env.AI_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct'

/** 火山方舟域名下优先 ARK_API_KEY，避免 .env 里 AI_API_KEY 占位符覆盖真实方舟密钥导致 401 */
const isVolcArk = /volces\.com|ark\.cn-beijing\.volces\.com/i.test(AI_BASE_URL)
const ark = (process.env.ARK_API_KEY ?? '').trim()
const ai = (process.env.AI_API_KEY ?? '').trim()
const oai = (process.env.OPENAI_API_KEY ?? '').trim()
const AI_KEY_SOURCE = isVolcArk
  ? ark
    ? 'ARK_API_KEY'
    : ai
      ? 'AI_API_KEY'
      : oai
        ? 'OPENAI_API_KEY'
        : 'none'
  : ai
    ? 'AI_API_KEY'
    : ark
      ? 'ARK_API_KEY'
      : oai
        ? 'OPENAI_API_KEY'
        : 'none'
const AI_API_KEY = isVolcArk ? ark || ai || oai : ai || ark || oai

/** 国内可用的 OpenAI 兼容语音转写（默认硅基流动 /v1/audio/transcriptions），与浏览器 Web Speech 无关 */
const STT_BASE_URL = (process.env.STT_BASE_URL ?? 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
const STT_API_KEY = (process.env.STT_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '').trim()
// 更高准确率优先：TeleSpeechASR 通常比 SenseVoiceSmall 更稳
const STT_MODEL = process.env.STT_MODEL ?? 'TeleAI/TeleSpeechASR'
const AUTH_TOKEN_SECRET = (() => {
  const configured = (process.env.AUTH_TOKEN_SECRET ?? '').trim()
  if (configured) {
    return configured
  }
  // 未配置时自动生成随机密钥，避免使用已知默认值导致 token 可被伪造
  const fallback = crypto.randomBytes(32).toString('hex')
  console.warn('[signal] ⚠ AUTH_TOKEN_SECRET 未配置，已自动生成随机密钥。已登录用户刷新后需重新登录。')
  return fallback
})()

const MYSQL_HOST = process.env.MYSQL_HOST?.trim()
const MYSQL_PORT = Number(process.env.MYSQL_PORT ?? 3306)
const MYSQL_USER = process.env.MYSQL_USER?.trim()
const MYSQL_PASSWORD = (process.env.MYSQL_PASSWORD ?? '').trim()
const MYSQL_DATABASE = process.env.MYSQL_DATABASE?.trim()
const MYSQL_ENABLED = Boolean(MYSQL_HOST && MYSQL_USER && MYSQL_DATABASE)
/** @type {mysql.Pool | null} */
let dbPool = null

if (process.env.NODE_ENV !== 'production') {
  console.log(
    `[signal] AI: key=${AI_API_KEY ? 'set' : 'missing'} (source ${AI_KEY_SOURCE}) base=${AI_BASE_URL} model=${AI_MODEL}`,
  )
  console.log(
    `[signal] STT: ${STT_API_KEY ? 'enabled' : 'disabled'} base=${STT_BASE_URL} model=${STT_MODEL} (大陆文字转写请配置 STT_API_KEY)`,
  )
  console.log(
    `[signal] DB: ${MYSQL_ENABLED ? 'enabled' : 'disabled'} db=${MYSQL_DATABASE ?? 'none'} host=${MYSQL_HOST ?? 'none'} user=${MYSQL_USER ?? 'none'} password=${MYSQL_PASSWORD ? 'set' : 'missing'}`,
  )
}

/**
 * @typedef {{ id: string, name: string, micOn: boolean, camOn: boolean, isHost: boolean, isSharingScreen: boolean, clientKey?: string }} Member
 * @typedef {{
 * members: Map<string, Member>,
 * hostId: string,
 * hostClientKey: string,
 * password: string,
 * locked: boolean,
 * createdAt: number
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map()

const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

const readJsonBody = (req, maxBytes = 1_000_000) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > maxBytes) {
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })

const createFallbackReply = (prompt) => `AI 服务未配置，暂时进入演示模式。\n你刚才的问题是：${prompt}`

const callOpenAI = async (messages, temperature = 0.3) => {
  if (!AI_API_KEY) {
    return null
  }
  const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature,
      messages,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`AI provider request failed: ${response.status} ${errorText}`)
  }

  const data = await response.json()
  return data?.choices?.[0]?.message?.content?.trim() ?? ''
}

const handleAiChat = async (req, res) => {
  const payload = await readJsonBody(req)
  const roomId = String(payload.roomId ?? '')
  const username = String(payload.username ?? '参会者')
  const prompt = String(payload.prompt ?? '')
  const messages = Array.isArray(payload.messages) ? payload.messages : []

  if (!prompt.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'prompt is required' }))
    return
  }

  if (!AI_API_KEY) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        answer: createFallbackReply(prompt),
      }),
    )
    return
  }

  const contextLines = messages
    .slice(-20)
    .map((item) => `${item.sender ?? '成员'}: ${item.text ?? ''}`)
    .join('\n')
  const hasChat = messages.some((item) => String(item.text ?? '').trim())

  try {
    const answer = await callOpenAI(
      [
        {
          role: 'system',
          content:
            '你是在线会议助手。请用中文回答，优先提炼重点，输出简洁、可执行、适合答辩场景。严禁编造聊天记录中不存在的具体发言或事实。',
        },
        {
          role: 'user',
          content: `会议号: ${roomId}\n提问人: ${username}\n会中聊天记录:\n${contextLines || '（暂无）'}\n\n问题: ${prompt}${hasChat ? '' : '\n\n说明：当前会中聊天为空，请先明确说明「暂无会中文字记录」，勿虚构会议讨论；可给出与问题相关的通用答辩建议。'}`,
        },
      ],
      0.4,
    )

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ answer }))
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        answer: `AI 服务调用失败，已切换演示模式。\n问题：${prompt}\n建议：请检查 AI_API_KEY、AI_BASE_URL、AI_MODEL 和网络连通性。`,
        degraded: true,
        detail: error instanceof Error ? error.message : 'Unknown error',
      }),
    )
  }
}

const handleAiSummary = async (req, res) => {
  const payload = await readJsonBody(req)
  const roomId = String(payload.roomId ?? '')
  const username = String(payload.username ?? '')
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const members = Array.isArray(payload.members) ? payload.members : []

  if (!AI_API_KEY) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        summary:
          'AI 服务未配置（缺少 OPENAI_API_KEY）。演示总结：\n1. 会议已完成基础讨论。\n2. 建议整理答辩亮点与风险。\n3. 会后跟进任务请在成员间分配。',
      }),
    )
    return
  }

  const contextLines = messages
    .slice(-50)
    .map((item) => `${item.sender ?? '成员'}: ${item.text ?? ''}`)
    .join('\n')
  const memberNames = members.map((item) => item.name).join('、')
  const hasTranscript = messages.some((item) => String(item.text ?? '').trim())

  try {
    const summary = await callOpenAI(
      [
        {
          role: 'system',
          content: hasTranscript
            ? '你是会议纪要助手。用中文输出，结构包含：会议摘要、关键结论、待办事项（负责人+截止时间建议）、风险提醒。只能依据用户提供的聊天记录归纳，不得编造未出现的具体发言、数字或结论；信息不足处请写「会中记录未涉及」。'
            : '你是会议纪要助手。当前没有会中文字记录。请先用一两句话说明「以下为无记录时的演练用模板，非真实会议内容」，再给出简短的答辩演练纪要框架（摘要/结论/待办/风险各用列表即可），勿写成仿佛会议已真实发生。',
        },
        {
          role: 'user',
          content: hasTranscript
            ? `会议号: ${roomId}\n发起人: ${username}\n参会成员: ${memberNames}\n聊天记录:\n${contextLines}\n\n请根据以上记录生成会后纪要。`
            : `会议号: ${roomId}\n发起人: ${username}\n参会成员: ${memberNames}\n聊天记录:（空）\n\n无文字记录，请按系统说明输出标注清晰的模板纪要。`,
        },
      ],
      0.2,
    )

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ summary }))
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        summary:
          'AI 服务调用失败，已降级为演示纪要。\n\n## 会议摘要\n- 本次会议完成核心功能演示与讨论。\n\n## 关键结论\n- 需确认 AI 服务密钥与网络连通后再切换到正式模式。\n\n## 待办事项\n- 负责人：项目成员；任务：检查 AI_API_KEY、AI_BASE_URL、AI_MODEL 和网络；建议截止：今天内。\n\n## 风险提醒\n- 当前 AI 输出为降级模式，内容仅用于演示。',
        degraded: true,
        detail: error instanceof Error ? error.message : 'Unknown error',
      }),
    )
  }
}

const createAgentFallback = (goal, plan, steps, review = '') => {
  const lines = [
    'AI 智能体当前处于演示降级模式（未配置或无法调用外部模型）。',
    `目标：${goal}`,
    '',
    '已执行步骤：',
    ...steps.map((s, idx) => `${idx + 1}. ${s.tool} - ${s.reason}`),
    review ? `\n复盘：${review}` : '',
    '',
    '建议：请配置 AI_API_KEY / ARK_API_KEY 后再试，以获得更高质量策略输出。',
  ]
  return { answer: lines.join('\n'), plan, steps, review }
}

const buildAgentPlan = (goal) => {
  const text = String(goal ?? '').toLowerCase()
  const plan = ['梳理会中关键信息', '抽取可执行行动项', '给出最终答辩建议']
  if (text.includes('纪要') || text.includes('总结') || text.includes('summary')) {
    return ['提取会议核心讨论', '生成结构化纪要草稿', '给出会后跟进建议']
  }
  if (text.includes('答辩') || text.includes('演讲') || text.includes('汇报')) {
    return ['分析当前讨论亮点和风险', '整理答辩表达提纲', '输出可直接陈述的结论']
  }
  if (text.includes('待办') || text.includes('行动') || text.includes('todo')) {
    return ['识别任务相关讨论', '汇总负责人与优先级', '输出可执行待办清单']
  }
  return plan
}

const toolExtractTopics = (messages) => {
  const uniq = new Set()
  const topics = []
  for (const item of messages.slice(-40)) {
    const t = String(item?.text ?? '').trim()
    if (!t) {
      continue
    }
    const normalized = t.slice(0, 30)
    if (uniq.has(normalized)) {
      continue
    }
    uniq.add(normalized)
    topics.push(`- ${item?.sender ?? '成员'}：${t}`)
    if (topics.length >= 10) {
      break
    }
  }
  return topics.join('\n') || '（会中暂无可用文本）'
}

const toolBuildActionItems = (messages) => {
  const keywords = ['需要', '建议', 'TODO', '待办', '后续', '优化', '修复', '确认', '安排']
  const picked = []
  for (const item of messages.slice(-60)) {
    const text = String(item?.text ?? '')
    if (!text.trim()) {
      continue
    }
    if (keywords.some((k) => text.includes(k))) {
      picked.push(`- ${item?.sender ?? '成员'}：${text.trim()}`)
    }
    if (picked.length >= 8) {
      break
    }
  }
  return picked.join('\n') || '（未识别到明确待办，建议人工补充负责人与截止时间）'
}

const toolMemberSnapshot = (members) => {
  const names = members.map((m) => `${m?.name ?? '成员'}${m?.isHost ? '(主持人)' : ''}`)
  return names.length > 0 ? names.join('、') : '（暂无成员信息）'
}

const toolRiskHints = (messages) => {
  const riskWords = ['风险', '问题', '失败', '报错', '超时', '冲突', '卡住', '不行', '延迟']
  const hits = []
  for (const item of messages.slice(-80)) {
    const text = String(item?.text ?? '').trim()
    if (!text) {
      continue
    }
    if (riskWords.some((k) => text.includes(k))) {
      hits.push(`- ${item?.sender ?? '成员'}：${text}`)
    }
    if (hits.length >= 6) {
      break
    }
  }
  return hits.join('\n') || '（未识别到明显风险语句）'
}

const handleAiAgent = async (req, res) => {
  const payload = await readJsonBody(req)
  const goal = String(payload.goal ?? '').trim()
  const roomId = String(payload.roomId ?? '')
  const username = String(payload.username ?? '参会者')
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const members = Array.isArray(payload.members) ? payload.members : []

  if (!goal) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'goal is required' }))
    return
  }

  const plan = buildAgentPlan(goal)
  const steps = [
    {
      tool: 'extract_topics',
      reason: '梳理会中上下文',
      output: toolExtractTopics(messages),
    },
    {
      tool: 'extract_actions',
      reason: '提取可执行任务',
      output: toolBuildActionItems(messages),
    },
    {
      tool: 'member_snapshot',
      reason: '确认参会角色',
      output: toolMemberSnapshot(members),
    },
    {
      tool: 'risk_hints',
      reason: '识别潜在风险',
      output: toolRiskHints(messages),
    },
  ]

  if (!AI_API_KEY) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(createAgentFallback(goal, plan, steps, '未连接外部模型，无法进行深度复盘。')))
    return
  }

  try {
    const toolContext = steps.map((s, i) => `${i + 1}. [${s.tool}] ${s.reason}\n${s.output}`).join('\n\n')
    const draft = await callOpenAI(
      [
        {
          role: 'system',
          content: '你是会议智能体的执行器。请基于工具输出给出“草稿答案”，结构包含：结论、证据、行动项、下一步。不要编造事实。',
        },
        {
          role: 'user',
          content: `会议号：${roomId}\n提问人：${username}\n目标：${goal}\n执行计划：\n${plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n工具输出：\n${toolContext}`,
        },
      ],
      0.3,
    )
    const review = await callOpenAI(
      [
        {
          role: 'system',
          content: '你是会议智能体复盘器。请检查草稿是否有臆测、遗漏、行动项不明确，并给出简短复盘建议（3-5行）。',
        },
        {
          role: 'user',
          content: `目标：${goal}\n\n工具输出：\n${toolContext}\n\n草稿：\n${draft}`,
        },
      ],
      0.2,
    )
    const answer = await callOpenAI(
      [
        {
          role: 'system',
          content:
            '你是会议智能体终稿器。请根据草稿和复盘意见生成最终回答，格式固定：\n1) 结论\n2) 证据\n3) 行动项（负责人+截止建议）\n4) 下一步\n不得编造未出现的事实。',
        },
        {
          role: 'user',
          content: `目标：${goal}\n\n草稿：\n${draft}\n\n复盘意见：\n${review}`,
        },
      ],
      0.25,
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ answer, plan, steps, review }))
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ...createAgentFallback(goal, plan, steps, '调用模型失败，已回退为规则化结果。'),
        degraded: true,
        detail: error instanceof Error ? error.message : 'Unknown error',
      }),
    )
  }
}

const callOpenAITranscription = async (buffer, mimeType) => {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), 'speech.webm')
  form.append('model', STT_MODEL)
  // 尽量锁定中文场景，减少 “Yeah” 这类误识别
  form.append('language', 'zh')
  const response = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STT_API_KEY}`,
    },
    body: form,
  })
  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`${response.status} ${errText.slice(0, 400)}`)
  }
  const data = await response.json()
  return String(data.text ?? '').trim()
}

const hashPassword = (rawPassword) => {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(rawPassword, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

const verifyPassword = (rawPassword, storedPassword) => {
  const [salt, expected] = String(storedPassword ?? '').split(':')
  if (!salt || !expected) {
    return false
  }
  const actual = crypto.scryptSync(rawPassword, salt, 64).toString('hex')
  const left = Buffer.from(actual, 'hex')
  const right = Buffer.from(expected, 'hex')
  if (left.length !== right.length) {
    return false
  }
  return crypto.timingSafeEqual(left, right)
}

const toBase64Url = (input) =>
  Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const fromBase64Url = (input) => {
  const normalized = String(input).replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '==='.slice((normalized.length + 3) % 4)
  return Buffer.from(padded, 'base64').toString()
}

const signToken = (payload) => {
  const data = toBase64Url(JSON.stringify(payload))
  const sig = toBase64Url(crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(data).digest())
  return `${data}.${sig}`
}

const parseToken = (token) => {
  const [data, sig] = String(token ?? '').split('.')
  if (!data || !sig) {
    return null
  }
  const expected = toBase64Url(crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(data).digest())
  const left = Buffer.from(sig)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return null
  }
  try {
    const payload = JSON.parse(fromBase64Url(data))
    if (!payload?.uid || !payload?.exp || Number(payload.exp) < Date.now()) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

const readBearerToken = (req) => {
  const auth = String(req.headers.authorization ?? '')
  if (!auth.startsWith('Bearer ')) {
    return ''
  }
  return auth.slice(7).trim()
}

const handleAuthRegister = async (req, res) => {
  const payload = await readJsonBody(req)
  const username = String(payload.username ?? '').trim()
  const displayName = String(payload.displayName ?? '').trim()
  const password = String(payload.password ?? '')

  if (!username || !displayName || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'username/displayName/password is required' }))
    return
  }
  if (username.length < 3 || password.length < 6) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '用户名至少3位，密码至少6位。' }))
    return
  }
  if (!dbPool) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '数据库未连接，无法注册。' }))
    return
  }

  const [exists] = await dbPool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [username])
  if (Array.isArray(exists) && exists.length > 0) {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '用户名已存在。' }))
    return
  }

  const passwordHash = hashPassword(password)
  const [insertResult] = await dbPool.query(
    'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [username, displayName, passwordHash, Date.now()],
  )
  const userId = Number(insertResult?.insertId ?? 0)
  const token = signToken({
    uid: userId,
    username,
    displayName,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, user: { id: userId, username, displayName }, token }))
}

const handleAuthLogin = async (req, res) => {
  const payload = await readJsonBody(req)
  const username = String(payload.username ?? '').trim()
  const password = String(payload.password ?? '')
  if (!username || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'username/password is required' }))
    return
  }
  if (!dbPool) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '数据库未连接，无法登录。' }))
    return
  }
  const [rows] = await dbPool.query(
    'SELECT id, username, display_name AS displayName, password_hash AS passwordHash FROM users WHERE username = ? LIMIT 1',
    [username],
  )
  const record = Array.isArray(rows) ? rows[0] : null
  if (!record || !verifyPassword(password, record.passwordHash)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '用户名或密码错误。' }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const token = signToken({
    uid: Number(record.id),
    username: record.username,
    displayName: record.displayName,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })
  res.end(
    JSON.stringify({
      ok: true,
      user: { id: Number(record.id), username: record.username, displayName: record.displayName },
      token,
    }),
  )
}

const handleAuthMe = async (req, res) => {
  const token = readBearerToken(req)
  const payload = parseToken(token)
  if (!payload) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '未登录或登录已过期。' }))
    return
  }
  if (!dbPool) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '数据库未连接。' }))
    return
  }
  const [rows] = await dbPool.query(
    'SELECT id, username, display_name AS displayName FROM users WHERE id = ? LIMIT 1',
    [Number(payload.uid)],
  )
  const user = Array.isArray(rows) ? rows[0] : null
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '账号不存在。' }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, user: { id: Number(user.id), username: user.username, displayName: user.displayName } }))
}

const handleAuthLogout = async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

const initDb = async (retries = 3, delayMs = 5000) => {
  if (!MYSQL_ENABLED) {
    return
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      dbPool = mysql.createPool({
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        database: MYSQL_DATABASE,
        charset: 'utf8mb4',
        connectionLimit: 8,
      })
      // 验证连接可用
      await dbPool.query('SELECT 1')
      console.log(`[signal] DB 连接成功（第 ${attempt} 次尝试）`)

      // 建表
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS meeting_records (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          room_id VARCHAR(64) NOT NULL,
          username VARCHAR(128) NOT NULL,
          joined_at BIGINT NOT NULL,
          left_at BIGINT NOT NULL,
          duration_sec INT NOT NULL DEFAULT 0,
          message_count INT NOT NULL DEFAULT 0,
          participant_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS scheduled_meetings (
          id VARCHAR(64) PRIMARY KEY,
          topic VARCHAR(255) NOT NULL,
          room_id VARCHAR(64) NOT NULL,
          host_name VARCHAR(128) NOT NULL,
          start_at BIGINT NOT NULL,
          password VARCHAR(128) DEFAULT '',
          created_at BIGINT NOT NULL
        )
      `)
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          username VARCHAR(64) NOT NULL UNIQUE,
          display_name VARCHAR(128) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at BIGINT NOT NULL
        )
      `)
      return
    } catch (error) {
      console.error(`[signal] DB 连接失败（第 ${attempt}/${retries} 次）：`, error.message)
      if (dbPool) {
        try { await dbPool.end() } catch { /* ignore */ }
        dbPool = null
      }
      if (attempt < retries) {
        console.log(`[signal] ${delayMs / 1000} 秒后重试...`)
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
}

const handleGetRecords = async (res) => {
  if (!dbPool) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records: [] }))
    return
  }
  try {
    const [rows] = await dbPool.query(
      `SELECT id, room_id AS roomId, username, joined_at AS joinedAt, left_at AS leftAt,
              duration_sec AS durationSec, message_count AS messageCount,
              participant_count AS participantCount
         FROM meeting_records ORDER BY left_at DESC LIMIT 100`,
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records: rows }))
  } catch (error) {
    console.error('[signal] get records failed:', error)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records: [] }))
  }
}

const handleSaveRecord = async (req, res) => {
  const payload = await readJsonBody(req)
  if (!dbPool) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, persisted: false }))
    return
  }
  const joinedAt = Number(payload.joinedAt ?? 0)
  const leftAtRaw = Number(payload.leftAt ?? Date.now())
  const leftAt = Number.isFinite(leftAtRaw) ? leftAtRaw : Date.now()
  const durationSec = Math.max(0, Math.round((leftAt - joinedAt) / 1000))
  const messageCount = Math.max(0, Number(payload.messageCount ?? 0))
  const participantCount = Math.max(0, Number(payload.participantCount ?? 0))

  try {
    await dbPool.query(
      `INSERT INTO meeting_records
        (room_id, username, joined_at, left_at, duration_sec, message_count, participant_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(payload.roomId ?? ''),
        String(payload.username ?? ''),
        joinedAt,
        leftAt,
        durationSec,
        messageCount,
        participantCount,
      ],
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, persisted: true }))
  } catch (error) {
    console.error('[signal] save record failed:', error)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, persisted: false }))
  }
}

const handleDeleteRecord = async (req, res) => {
  const payload = await readJsonBody(req)
  if (!dbPool) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: 0 }))
    return
  }
  const idRaw = payload.id
  const id = Number.isFinite(Number(idRaw)) ? Number(idRaw) : 0
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'id is required' }))
    return
  }
  try {
    const [result] = await dbPool.query('DELETE FROM meeting_records WHERE id = ? LIMIT 1', [id])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: Number(result?.affectedRows ?? 0) }))
  } catch (error) {
    console.error('[signal] delete record failed:', error)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: 0 }))
  }
}

const handleGetSchedules = async (res) => {
  if (!dbPool) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ meetings: [] }))
    return
  }
  try {
    const [rows] = await dbPool.query(
      `SELECT id, topic, room_id AS roomId, host_name AS hostName,
              start_at AS startAt, password, created_at AS createdAt
         FROM scheduled_meetings ORDER BY start_at ASC LIMIT 100`,
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ meetings: rows }))
  } catch (error) {
    console.error('[signal] get schedules failed:', error)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ meetings: [] }))
  }
}

const handleSaveSchedule = async (req, res) => {
  const payload = await readJsonBody(req)
  if (!dbPool) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, persisted: false }))
    return
  }
  try {
    await dbPool.query(
      `REPLACE INTO scheduled_meetings
        (id, topic, room_id, host_name, start_at, password, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(payload.id ?? ''),
        String(payload.topic ?? ''),
        String(payload.roomId ?? ''),
        String(payload.hostName ?? ''),
        Number(payload.startAt ?? Date.now()),
        String(payload.password ?? ''),
        Number(payload.createdAt ?? Date.now()),
      ],
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, persisted: true }))
  } catch (error) {
    console.error('[signal] save schedule failed:', error)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, persisted: false }))
  }
}

const handleDeleteSchedule = async (req, res) => {
  const payload = await readJsonBody(req)
  if (!dbPool) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: 0 }))
    return
  }
  const id = String(payload.id ?? '').trim()
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'id is required' }))
    return
  }
  try {
    const [result] = await dbPool.query('DELETE FROM scheduled_meetings WHERE id = ? LIMIT 1', [id])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: Number(result?.affectedRows ?? 0) }))
  } catch (error) {
    console.error('[signal] delete schedule failed:', error)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted: 0 }))
  }
}

const handleSttStatus = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      enabled: Boolean(STT_API_KEY),
      model: STT_MODEL,
    }),
  )
}

const handleStt = async (req, res) => {
  if (!STT_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        text: '',
        error: '未配置 STT_API_KEY（建议使用硅基流动等国内可访问的转写服务）',
      }),
    )
    return
  }
  let payload
  try {
    payload = await readJsonBody(req, 8_000_000)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '', error: 'Invalid JSON body' }))
    return
  }
  const audioBase64 = String(payload.audioBase64 ?? '')
  const mimeType = String(payload.mimeType ?? 'audio/webm')
  if (!audioBase64) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '', error: 'audioBase64 required' }))
    return
  }
  let buf
  try {
    buf = Buffer.from(audioBase64, 'base64')
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '', error: 'invalid base64' }))
    return
  }
  if (buf.length < 80) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '' }))
    return
  }
  try {
    const text = await callOpenAITranscription(buf, mimeType)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text }))
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        text: '',
        error: error instanceof Error ? error.message : 'transcription failed',
      }),
    )
  }
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/api/ai/chat') {
    try {
      await handleAiChat(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'AI chat failed' }))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/ai/summary') {
    try {
      await handleAiSummary(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'AI summary failed' }))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/ai/agent') {
    try {
      await handleAiAgent(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'AI agent failed' }))
    }
    return
  }

  if (req.method === 'GET' && req.url === '/api/stt/status') {
    handleSttStatus(req, res)
    return
  }

  if (req.method === 'GET' && req.url === '/api/data/records') {
    await handleGetRecords(res)
    return
  }

  if (req.method === 'POST' && req.url === '/api/data/records') {
    await handleSaveRecord(req, res)
    return
  }

  if (req.method === 'GET' && req.url === '/api/data/schedules') {
    await handleGetSchedules(res)
    return
  }

  if (req.method === 'POST' && req.url === '/api/data/schedules') {
    await handleSaveSchedule(req, res)
    return
  }

  if (req.method === 'DELETE' && req.url === '/api/data/records') {
    try {
      await handleDeleteRecord(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'delete record failed' }))
    }
    return
  }

  if (req.method === 'DELETE' && req.url === '/api/data/schedules') {
    try {
      await handleDeleteSchedule(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'delete schedule failed' }))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/stt') {
    try {
      await handleStt(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'STT failed' }))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/auth/register') {
    try {
      await handleAuthRegister(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'register failed' }))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/auth/login') {
    try {
      await handleAuthLogin(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'login failed' }))
    }
    return
  }

  if (req.method === 'GET' && req.url === '/api/auth/me') {
    try {
      await handleAuthMe(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'me failed' }))
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/auth/logout') {
    try {
      await handleAuthLogout(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'logout failed' }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})
const io = new Server(server, {
  cors: {
    origin: '*',
  },
})

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name, password = '', createIfMissing = false, clientKey = '' }) => {
    if (!roomId || !name) {
      return
    }
    const normalizedClientKey = String(clientKey ?? '').trim()

    const existingRoom = rooms.get(roomId)
    if (!existingRoom && !createIfMissing) {
      socket.emit('join-error', {
        message:
          '会议不存在：尚未有人用「创建会议」进入过该号。请主持人先创建并进入，或你也在加入页选「创建会议」后使用同一会议号。',
      })
      return
    }

    /** @type {Room} */
    const room =
      existingRoom ??
      {
        members: new Map(),
        hostId: socket.id,
        hostClientKey: normalizedClientKey,
        password: String(password ?? ''),
        locked: false,
        createdAt: Date.now(),
        chatLog: [],
      }

    if (existingRoom) {
      if (room.locked) {
        socket.emit('join-error', { message: '会议已锁定，无法加入。' })
        return
      }
      if (room.password && room.password !== String(password ?? '')) {
        socket.emit('join-error', { message: '会议密码错误。' })
        return
      }
    }

    socket.join(roomId)
    socket.data.roomId = roomId
    const shouldBeHost =
      (!existingRoom && Boolean(normalizedClientKey)) ||
      (Boolean(normalizedClientKey) && room.hostClientKey && room.hostClientKey === normalizedClientKey)
    const isHost = !existingRoom ? Boolean(shouldBeHost) : Boolean(shouldBeHost)
    if (!existingRoom && !room.hostClientKey && normalizedClientKey) {
      room.hostClientKey = normalizedClientKey
    }
    if (isHost) {
      room.hostId = socket.id
      room.hostClientKey = normalizedClientKey || room.hostClientKey
      room.members.forEach((m) => {
        m.isHost = false
      })
    }

    socket.data.member = {
      id: socket.id,
      name,
      micOn: true,
      camOn: true,
      isHost,
      isSharingScreen: false,
      handRaised: false,
      clientKey: normalizedClientKey || undefined,
    }

    rooms.set(roomId, room)
    room.members.set(socket.id, socket.data.member)

    if (isHost) {
      io.to(roomId).emit('host-changed', { hostId: socket.id, members: Array.from(room.members.values()) })
      io.to(roomId).emit('room-meta', {
        locked: room.locked,
        hasPassword: Boolean(room.password),
        hostId: room.hostId,
        createdAt: room.createdAt,
      })
    }

    // 下发全量成员列表（包含自己），由前端根据 selfId 过滤展示，避免状态反复“丢字段/丢举手”
    socket.emit('room-members', {
      members: Array.from(room.members.values()),
      selfId: socket.id,
      roomMeta: {
        locked: room.locked,
        hasPassword: Boolean(room.password),
        hostId: room.hostId,
        createdAt: room.createdAt,
      },
      chatLog: room.chatLog ?? [],
    })
    socket.to(roomId).emit('peer-joined', { member: socket.data.member })
  })

  socket.on('signal', ({ roomId, targetId, signal }) => {
    if (!roomId || !targetId || !signal) {
      return
    }
    io.to(targetId).emit('signal', {
      fromId: socket.id,
      signal,
    })
  })

  socket.on('member-update', ({ roomId, micOn, camOn, isSharingScreen, handRaised }) => {
    const member = socket.data.member
    const room = rooms.get(roomId)
    if (!roomId || !member || !room) {
      return
    }

    member.micOn = Boolean(micOn)
    member.camOn = Boolean(camOn)
    member.isSharingScreen = Boolean(isSharingScreen)
    if (typeof handRaised === 'boolean') {
      member.handRaised = handRaised
    }
    member.handRaised = Boolean(member.handRaised)
    io.to(roomId).emit('member-update', { member })
  })

  socket.on('hand-raise', ({ roomId, handRaised }, ack) => {
    const member = socket.data.member
    const room = rooms.get(roomId)
    if (!roomId || !member || !room) {
      if (typeof ack === 'function') {
        ack({ ok: false })
      }
      return
    }
    member.handRaised = Boolean(handRaised)
    io.to(roomId).emit('member-update', { member })
    if (typeof ack === 'function') {
      ack({ ok: true })
    }
  })

  socket.on('chat-message', ({ roomId, message }) => {
    if (!roomId || !message) {
      return
    }
    const room = rooms.get(roomId)
    if (room) {
      room.chatLog.push(message)
      if (room.chatLog.length > 500) {
        room.chatLog = room.chatLog.slice(-500)
      }
    }
    io.to(roomId).emit('chat-message', message)
  })

  socket.on('private-chat-message', (payload, ack) => {
    const reply = (result) => {
      if (typeof ack === 'function') {
        ack(result)
      }
    }
    const { roomId, message } = payload ?? {}
    if (!roomId || !message) {
      reply({ ok: false, error: '参数无效。' })
      return
    }
    const room = rooms.get(roomId)
    if (!room || !room.members.has(socket.id)) {
      socket.emit('private-chat-error', { message: '发送失败：未加入该会议。' })
      reply({ ok: false, error: '发送失败：未加入该会议。' })
      return
    }
    const toId = String(message.toId ?? '').trim()
    if (!toId || toId === socket.id) {
      socket.emit('private-chat-error', { message: '发送失败：请选择私聊对象。' })
      reply({ ok: false, error: '发送失败：请选择私聊对象。' })
      return
    }
    if (!room.members.has(toId)) {
      socket.emit('private-chat-error', {
        message: '发送失败：对方已离开或成员列表已更新，请重新选择私聊对象。',
      })
      reply({ ok: false, error: '发送失败：对方已离开或成员列表已更新。' })
      return
    }
    const fromMember = room.members.get(socket.id)
    const toMember = room.members.get(toId)
    if (!fromMember || !toMember) {
      socket.emit('private-chat-error', { message: '发送失败：成员不存在。' })
      reply({ ok: false, error: '发送失败：成员不存在。' })
      return
    }
    const text = String(message.text ?? '').trim()
    if (!text) {
      reply({ ok: false, error: '消息不能为空。' })
      return
    }
    const payloadOut = {
      id: String(message.id ?? crypto.randomUUID()),
      sender: fromMember.name,
      text,
      createdAt: Number(message.createdAt ?? Date.now()),
      isPrivate: true,
      fromId: socket.id,
      toId,
      toName: toMember.name,
    }
    /**
     * 与会中公聊一样走 io.to(roomId)：保证两端都能收到（单独 io.to(socketId) 在部分环境/时机下对端收不到）。
     * 客户端仅处理 toId/fromId 与本人 socket.id 一致的包，其它成员忽略。
     */
    try {
      // 私聊消息不存入 chatLog，避免新成员加入时看到他人私聊内容
      io.to(roomId).emit('private-chat-message', payloadOut)
      reply({ ok: true })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      socket.emit('private-chat-error', { message: `发送失败：${detail}` })
      reply({ ok: false, error: `发送失败：${detail}` })
    }
  })

  socket.on('whiteboard-draw', ({ roomId, stroke }) => {
    if (!roomId || !stroke) {
      return
    }
    socket.to(roomId).emit('whiteboard-draw', stroke)
  })

  socket.on('whiteboard-clear', ({ roomId }) => {
    if (!roomId) {
      return
    }
    io.to(roomId).emit('whiteboard-clear')
  })

  socket.on('host-set-room-lock', ({ roomId, locked }) => {
    const room = rooms.get(roomId)
    if (!room || room.hostId !== socket.id) {
      return
    }
    room.locked = Boolean(locked)
    io.to(roomId).emit('room-meta', {
      locked: room.locked,
      hasPassword: Boolean(room.password),
      hostId: room.hostId,
      createdAt: room.createdAt,
    })
  })

  socket.on('host-set-password', ({ roomId, password }) => {
    const room = rooms.get(roomId)
    if (!room || room.hostId !== socket.id) {
      return
    }
    room.password = String(password ?? '').trim()
    io.to(roomId).emit('room-meta', {
      locked: room.locked,
      hasPassword: Boolean(room.password),
      hostId: room.hostId,
      createdAt: room.createdAt,
    })
  })

  socket.on('host-mute-all', ({ roomId }) => {
    const room = rooms.get(roomId)
    if (!room || room.hostId !== socket.id) {
      return
    }

    room.members.forEach((member, memberId) => {
      if (memberId !== room.hostId) {
        member.micOn = false
        io.to(memberId).emit('force-mute')
        io.to(roomId).emit('member-update', { member })
      }
    })
  })

  socket.on('host-remove-member', ({ roomId, targetId }) => {
    const room = rooms.get(roomId)
    if (!room || room.hostId !== socket.id || !targetId || targetId === room.hostId) {
      return
    }
    // 主动从成员列表中删除，不依赖 disconnect 事件
    room.members.delete(targetId)
    io.to(roomId).emit('member-left', { id: targetId })
    io.to(targetId).emit('removed-by-host')
    const targetSocket = io.sockets.sockets.get(targetId)
    targetSocket?.disconnect(true)
  })

  socket.on('host-transfer', ({ roomId, targetId }) => {
    const room = rooms.get(roomId)
    if (!room || room.hostId !== socket.id || !targetId || !room.members.has(targetId)) {
      return
    }
    const currentHost = room.members.get(room.hostId)
    if (currentHost) {
      currentHost.isHost = false
    }
    const newHost = room.members.get(targetId)
    if (!newHost) {
      return
    }
    newHost.isHost = true
    room.hostId = targetId
    room.hostClientKey = String(newHost.clientKey ?? '').trim() || room.hostClientKey
    io.to(roomId).emit('host-changed', { hostId: newHost.id, members: Array.from(room.members.values()) })
    io.to(roomId).emit('room-meta', {
      locked: room.locked,
      hasPassword: Boolean(room.password),
      hostId: room.hostId,
      createdAt: room.createdAt,
    })
  })

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId
    if (!roomId) {
      return
    }
    const room = rooms.get(roomId)
    if (!room) {
      return
    }

    room.members.delete(socket.id)
    socket.to(roomId).emit('member-left', { id: socket.id })
    if (room.members.size === 0) {
      rooms.delete(roomId)
      return
    }

    if (room.hostId === socket.id) {
      // 主持人刷新会触发断开/重连：保持 hostClientKey 不变，让其重连后自动恢复主持人。
      const prevHost = socket.data.member
      const prevClientKey = String(prevHost?.clientKey ?? '').trim()
      if (!prevClientKey) {
        const [newHost] = room.members.values()
        if (newHost) {
          room.hostId = newHost.id
          newHost.isHost = true
          room.hostClientKey = String(newHost.clientKey ?? '').trim() || room.hostClientKey
          io.to(roomId).emit('host-changed', { hostId: newHost.id, members: Array.from(room.members.values()) })
          io.to(roomId).emit('room-meta', {
            locked: room.locked,
            hasPassword: Boolean(room.password),
            hostId: room.hostId,
            createdAt: room.createdAt,
          })
        }
      } else {
        // 临时把主持人指向现存任意成员以保证“主持功能”可用；但 hostClientKey 保持为原主持人
        const [tempHost] = room.members.values()
        if (tempHost) {
          room.hostId = tempHost.id
          tempHost.isHost = true
          io.to(roomId).emit('host-changed', { hostId: tempHost.id, members: Array.from(room.members.values()) })
          io.to(roomId).emit('room-meta', {
            locked: room.locked,
            hasPassword: Boolean(room.password),
            hostId: room.hostId,
            createdAt: room.createdAt,
          })
        }
        room.hostClientKey = prevClientKey
      }
    }
  })
})

void initDb()
  .catch((error) => {
    console.error('[signal] DB init failed:', error)
  })
  .finally(() => {
    const bindHost = (process.env.BIND_HOST ?? '127.0.0.1').trim() || '127.0.0.1'
    server.listen(PORT, bindHost, () => {
      console.log(`Signaling server is running on http://${bindHost}:${PORT}`)
    })
  })
