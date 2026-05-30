import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { fetchAuthMe, getAuthToken, getAuthUser } from '../utils/auth'

type Props = {
  children: ReactElement
}

function ProtectedRoute({ children }: Props) {
  const location = useLocation()
  const [checking, setChecking] = useState(true)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    const token = getAuthToken()
    if (!token) {
      setAuthed(false)
      setChecking(false)
      return
    }
    void fetchAuthMe()
      .then(() => setAuthed(true))
      .catch(() => {
        // 信令短暂不可达或超时时，不强制踢下线：仍允许本地 token + 缓存用户进入页面（预约会议等入口可点）
        setAuthed(Boolean(getAuthToken() && getAuthUser()))
      })
      .finally(() => setChecking(false))
  }, [])

  if (checking) {
    return (
      <main className="page join-page">
        <div className="join-card">
          <h2>正在校验登录状态...</h2>
          <p>请稍候。</p>
        </div>
      </main>
    )
  }
  if (!authed) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />
  }
  return children
}

export default ProtectedRoute
