import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MeetingRecord } from '../types/meeting'
import { getAuthUser, logoutAuthUser } from '../utils/auth'
import { getMeetingRecordsRemote } from '../utils/storage'

const durationLabel = (sec: number) => {
  if (sec <= 0) {
    return '少于1分钟'
  }
  return `${Math.max(1, Math.ceil(sec / 60))} 分钟`
}

function LobbyPage() {
  const [records, setRecords] = useState<MeetingRecord[]>([])
  const [authUserName, setAuthUserName] = useState('')

  useEffect(() => {
    void getMeetingRecordsRemote(5).then(setRecords)
    const user = getAuthUser()
    setAuthUserName(user?.displayName ?? '')
  }, [])

  return (
    <main className="page lobby">
      <header className="top-nav">
        <div className="brand">在线版视频会议</div>
        <nav className="nav-actions">
          {authUserName ? <span className="chat-time">已登录：{authUserName}</span> : null}
          {authUserName ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                void logoutAuthUser().finally(() => setAuthUserName(''))
              }}
            >
              退出登录
            </button>
          ) : (
            <Link to="/auth" className="ghost-btn">登录 / 注册</Link>
          )}
          <Link to="/schedule" className="ghost-btn">预约会议</Link>
          <Link to="/history" className="ghost-btn">历史会议</Link>
          <Link to="/join" className="primary-btn">
            快速入会
          </Link>
        </nav>
      </header>

      <section className="hero-section">
        <div className="hero-buttons">
          <Link to="/join?create=1" className="primary-btn">
            立即创建会议
          </Link>
          <Link to="/join" className="ghost-btn">
            使用会议号加入
          </Link>
        </div>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <h3>音视频稳定</h3>
          <p>基于 WebRTC 的实时通信能力，适合多人答辩互动。</p>
        </article>
        <article className="feature-card">
          <h3>主持人控场</h3>
          <p>支持全员静音、成员移除、举手管理和会议锁定。</p>
        </article>
        <article className="feature-card">
          <h3>可追溯记录</h3>
          <p>保留会议日志与成员行为，方便答辩归档与复盘。</p>
        </article>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <h3>最近会议记录</h3>
          {records.length === 0 ? (
            <p>暂无会后记录，结束一场会议后会自动沉淀到这里。</p>
          ) : (
            <div className="record-list">
              {records.map((record) => (
                <p key={`${record.roomId}-${record.leftAt}`}>
                  房间 {record.roomId} · {record.username} · {durationLabel(record.durationSec)}
                </p>
              ))}
            </div>
          )}
        </article>
      </section>
    </main>
  )
}

export default LobbyPage
