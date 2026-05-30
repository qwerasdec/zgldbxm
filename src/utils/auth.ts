import { SIGNAL_SERVER_URL } from '../constants/meeting'

export type AuthUser = {
  id: number
  username: string
  displayName: string
}

const AUTH_USER_KEY = 'tm-auth-user'
const AUTH_TOKEN_KEY = 'tm-auth-token'

const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY) ?? ''
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export const getAuthUser = (): AuthUser | null => {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as AuthUser
  } catch {
    return null
  }
}

export const clearAuthUser = () => {
  localStorage.removeItem(AUTH_USER_KEY)
  localStorage.removeItem(AUTH_TOKEN_KEY)
}

export const registerAuthUser = async (payload: {
  username: string
  displayName: string
  password: string
}): Promise<AuthUser> => {
  const response = await fetch(`${SIGNAL_SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await response.json()) as { user?: AuthUser; token?: string; error?: string }
  if (!response.ok || !data.user) {
    throw new Error(data.error ?? '注册失败')
  }
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user))
  if (data.token) {
    localStorage.setItem(AUTH_TOKEN_KEY, data.token)
  }
  return data.user
}

export const loginAuthUser = async (payload: {
  username: string
  password: string
}): Promise<AuthUser> => {
  const response = await fetch(`${SIGNAL_SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await response.json()) as { user?: AuthUser; token?: string; error?: string }
  if (!response.ok || !data.user) {
    throw new Error(data.error ?? '登录失败')
  }
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user))
  if (data.token) {
    localStorage.setItem(AUTH_TOKEN_KEY, data.token)
  }
  return data.user
}

export const getAuthToken = () => localStorage.getItem(AUTH_TOKEN_KEY) ?? ''

export const fetchAuthMe = async (): Promise<AuthUser> => {
  const response = await fetch(`${SIGNAL_SERVER_URL}/api/auth/me`, {
    method: 'GET',
    headers: {
      ...authHeaders(),
    },
    signal: AbortSignal.timeout(10_000),
  })
  const data = (await response.json()) as { user?: AuthUser; error?: string }
  if (!response.ok || !data.user) {
    clearAuthUser()
    throw new Error(data.error ?? '登录状态已失效')
  }
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user))
  return data.user
}

export const logoutAuthUser = async (): Promise<void> => {
  try {
    await fetch(`${SIGNAL_SERVER_URL}/api/auth/logout`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
      },
    })
  } catch {
    /* ignore network errors on logout */
  } finally {
    clearAuthUser()
  }
}
