import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { getAuthToken } from '../utils/auth'
import { loginAuthUser, registerAuthUser } from '../utils/auth'

function AuthPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [tip, setTip] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setTip('')
    if (!username.trim() || !password.trim() || (isRegister && !displayName.trim())) {
      setTip('请完整填写信息。')
      return
    }
    setLoading(true)
    try {
      if (isRegister) {
        await registerAuthUser({
          username: username.trim(),
          displayName: displayName.trim(),
          password: password.trim(),
        })
      } else {
        await loginAuthUser({
          username: username.trim(),
          password: password.trim(),
        })
      }
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from !== '/auth' ? from : '/')
    } catch (error) {
      setTip(error instanceof Error ? error.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  if (getAuthToken()) {
    return (
      <main className="page join-page">
        <div className="join-card">
          <h2>你已登录</h2>
          <p>可直接返回首页继续使用。</p>
          <div className="join-actions">
            <Link to="/" className="primary-btn">返回首页</Link>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="page join-page">
      <form className="join-card" onSubmit={onSubmit}>
        <h2>{isRegister ? '账号注册' : '账号登录'}</h2>
        <p>{isRegister ? '创建账号后可用于登录并保存在数据库中。' : '输入账号密码登录。'}</p>
        <div className="join-mode-switch">
          <button
            type="button"
            className={`ghost-btn ${isRegister ? '' : 'active'}`}
            onClick={() => setIsRegister(false)}
          >
            登录
          </button>
          <button
            type="button"
            className={`ghost-btn ${isRegister ? 'active' : ''}`}
            onClick={() => setIsRegister(true)}
          >
            注册
          </button>
        </div>

        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="至少3位字母或数字" />
        </label>
        {isRegister ? (
          <label>
            显示名称
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：张同学" />
          </label>
        ) : null}
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少6位密码"
          />
        </label>

        {tip ? <p className="device-tip">{tip}</p> : null}
        <div className="join-actions">
          <Link to="/" className="ghost-btn">返回首页</Link>
          <button className="primary-btn" type="submit" disabled={loading}>
            {loading ? '提交中...' : isRegister ? '注册并登录' : '登录'}
          </button>
        </div>
      </form>
    </main>
  )
}

export default AuthPage
