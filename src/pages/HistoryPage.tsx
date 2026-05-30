import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MeetingRecord, ScheduledMeeting } from '../types/meeting'
import {
  deleteMeetingRecordRemote,
  deleteScheduledMeetingRemote,
  getMeetingRecordsRemote,
  getScheduledMeetingsRemote,
} from '../utils/storage'

function toMinuteLabel(sec: number) {
  if (sec <= 0) {
    return '少于1分钟'
  }
  return `${Math.max(1, Math.ceil(sec / 60))} 分钟`
}

function toDateTimeLabel(ts: number) {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) {
    return '--'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function HistoryPage() {
  const [records, setRecords] = useState<MeetingRecord[]>([])
  const [plans, setPlans] = useState<ScheduledMeeting[]>([])
  const [nowTs, setNowTs] = useState(() => Date.now())
  const navigate = useNavigate()

  const refreshHistory = () => {
    void getMeetingRecordsRemote().then(setRecords)
    void getScheduledMeetingsRemote().then(setPlans)
  }

  useEffect(() => {
    refreshHistory()
  }, [])

  useEffect(() => {
    const t = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const remainingLabel = (startAt: number) => {
    const diffMs = startAt - nowTs
    if (diffMs <= 0) return ''
    const sec = Math.max(1, Math.ceil(diffMs / 1000))
    return `未到时间（倒计时${sec}s）`
  }

  return (
    <main className="page lobby">
      <header className="top-nav">
        <div className="brand">历史会议</div>
        <nav className="nav-actions">
          <Link to="/" className="ghost-btn">返回首页</Link>
          <Link to="/schedule" className="primary-btn">预约会议</Link>
        </nav>
      </header>

      <section className="feature-grid">
        <article className="feature-card">
          <h3>已预约会议</h3>
          {plans.length === 0 ? <p>暂无预约会议。</p> : plans.map((p) => (
            <p key={p.id}>
              {p.topic} · {new Date(p.startAt).toLocaleString('zh-CN')} ·
              {' '}
              {nowTs >= p.startAt ? (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => {
                    // 直接进入会议页，避免进入 /join 时触发”创建会议”表单。
                    // 这里 create=1 是为了：到点时如果房间尚不存在也能当场创建。
                    const pwd = encodeURIComponent(p.password ?? '')
                    navigate(`/meeting?room=${encodeURIComponent(p.roomId)}&name=${encodeURIComponent(p.hostName)}&pwd=${pwd}&create=1&mic=1&cam=1`)
                  }}
                >
                  进入
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="ghost-btn"
                  title={remainingLabel(p.startAt)}
                >
                  {remainingLabel(p.startAt)}
                </button>
              )}
              {' '}
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  if (!window.confirm('确认删除该预约会议？')) return
                  void deleteScheduledMeetingRemote(p.id).then(() => {
                    refreshHistory()
                  })
                }}
              >
                删除
              </button>
            </p>
          ))}
        </article>
        <article className="feature-card">
          <h3>会议记录</h3>
          {records.length === 0 ? <p>暂无会议记录。</p> : records.map((r) => (
            <p key={`${r.roomId}-${r.leftAt}`}>
              房间 {r.roomId} · {r.username} · {toMinuteLabel(r.durationSec)} · 消息 {r.messageCount}
              <br />
              开始 {toDateTimeLabel(r.joinedAt)} · 结束 {toDateTimeLabel(r.leftAt)}
              {' '}
              <button
                type="button"
                className="ghost-btn"
                disabled={typeof r.id !== 'number'}
                title={typeof r.id !== 'number' ? '本地记录未包含 id，无法远程删除；请刷新后重试' : ''}
                onClick={() => {
                  if (!window.confirm('确认删除该会议记录？')) return
                  void deleteMeetingRecordRemote(r).then(() => {
                    refreshHistory()
                  })
                }}
              >
                删除
              </button>
            </p>
          ))}
        </article>
      </section>
    </main>
  )
}

export default HistoryPage
