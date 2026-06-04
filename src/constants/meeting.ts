const envSignalRaw =
  typeof import.meta.env.VITE_SIGNAL_SERVER_URL === 'string'
    ? import.meta.env.VITE_SIGNAL_SERVER_URL.trim()
    : ''

/**
 * 浏览器端：优先用当前页 origin（Nginx 反代 /socket.io、/api），避免生产包写死 localhost:3001。
 * https 页面若 env 仍是 http:// 则强制 origin，防止混合内容拦截 Socket。
 */
function resolveSignalServerUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin
    // 生产环境（Nginx 反代）：始终用当前页 http(s)://IP，避免构建时写死 https://IP 导致 Failed to fetch
    if (!import.meta.env.DEV) {
      return origin
    }
    if (!envSignalRaw) {
      return origin
    }
    if (window.location.protocol === 'https:' && envSignalRaw.startsWith('http:')) {
      return origin
    }
    if (window.location.protocol === 'http:' && envSignalRaw.startsWith('https:')) {
      return origin
    }
    return envSignalRaw
  }
  if (!import.meta.env.DEV) {
    return envSignalRaw || 'http://127.0.0.1:3001'
  }
  return envSignalRaw || 'http://localhost:5173'
}

export const SIGNAL_SERVER_URL = resolveSignalServerUrl()
export const MEETING_RECORDS_KEY = 'tm-meeting-records'
export const SCHEDULED_MEETINGS_KEY = 'tm-scheduled-meetings'
export const USERS_KEY = 'tm-users'

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ]
  // 与 deploy/setup-coturn.sh 默认账号一致；手机热点对称 NAT 需 TURN 中继
  if (typeof window !== 'undefined' && window.location.hostname) {
    const host = window.location.hostname
    servers.push({
      urls: [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`],
      username: 'turnuser',
      credential: 'turnpass123',
    })
  }
  return servers
}

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: buildIceServers(),
  iceCandidatePoolSize: 4,
}

/**
 * 仅用于 localStorage 本地缓存的演示账号（无需数据库）。
 * 生产环境请通过 /api/auth/register 注册真实账号，不要依赖此处的默认数据。
 */
export const DEFAULT_USERS = [
  { username: 'admin', password: '123456', displayName: '答辩管理员' },
  { username: 'teacher', password: '123456', displayName: '李老师' },
]
