import { SIGNAL_SERVER_URL } from '../constants/meeting'
import type { ChatMessage, MemberState } from '../types/meeting'

type AiHistoryItem = { role: 'user' | 'assistant'; content: string }

type AiChatPayload = {
  roomId: string
  username: string
  prompt: string
  messages: ChatMessage[]
  history?: AiHistoryItem[]
}

type AiSummaryPayload = {
  roomId: string
  username: string
  messages: ChatMessage[]
  members: MemberState[]
}

type AiAgentPayload = {
  roomId: string
  username: string
  goal: string
  messages: ChatMessage[]
  members: MemberState[]
  history?: AiHistoryItem[]
}

async function postJson<T>(path: string, payload: object): Promise<T> {
  const response = await fetch(`${SIGNAL_SERVER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error ?? 'AI request failed')
  }
  return data as T
}

export type AiChatResponse = {
  answer: string
  degraded?: boolean
  detail?: string
}

export type AiSummaryResponse = {
  summary: string
  degraded?: boolean
  detail?: string
}

export type AiAgentResponse = {
  answer: string
  plan: string[]
  steps: Array<{ tool: string; reason: string; output: string }>
  review?: string
  degraded?: boolean
  detail?: string
}

export async function askAiAssistant(payload: AiChatPayload): Promise<AiChatResponse> {
  return postJson<AiChatResponse>('/api/ai/chat', payload)
}

export async function generateAiSummary(payload: AiSummaryPayload): Promise<AiSummaryResponse> {
  return postJson<AiSummaryResponse>('/api/ai/summary', payload)
}

export async function runAiAgent(payload: AiAgentPayload): Promise<AiAgentResponse> {
  return postJson<AiAgentResponse>('/api/ai/agent', payload)
}
