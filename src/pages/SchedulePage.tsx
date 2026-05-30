import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ScheduledMeeting } from '../types/meeting'
import { getAuthUser } from '../utils/auth'
import { saveScheduledMeetingRemote } from '../utils/storage'

function SchedulePage() {
  const navigate = useNavigate()
  const authDisplayName = getAuthUser()?.displayName?.trim() || ''
  const [topic, setTopic] = useState('项目答辩预演')
  const [hostName, setHostName] = useState(authDisplayName || '张同学')
  const [roomId, setRoomId] = useState(() => String(Date.now()).slice(-9))
  const [password, setPassword] = useState('')
  const [startAt, setStartAt] = useState(() => new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16))

  const onSubmit = async () => {
    const ts = new Date(startAt).getTime()//new Date(startAt).getTime()：把用户选的会议时间转成时间戳（毫秒数）
    if (!topic.trim() || !hostName.trim() || !roomId.trim() || Number.isNaN(ts)) {
      return
    }
    const meeting: ScheduledMeeting = {
      id: crypto.randomUUID(),//生成一个唯一的ID
      topic: topic.trim(),
      roomId: roomId.trim(),
      hostName: hostName.trim(),
      startAt: ts,//会议开始时间戳
      password: password.trim(),
      createdAt: Date.now(),
    }
    await saveScheduledMeetingRemote(meeting)//把构建好的会议数据发送给服务器，保存到后端数据库
    navigate('/history')//保存成功后让用户看到自己创建的预定会议
  }

  return (
    <main className="page join-page">
      <section className="join-card">
        <h2>预约会议</h2>
        <p>创建后可在历史会议中查看并快速入会。</p>
        <label>会议主题<input value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
        <label>主持人昵称<input value={hostName} onChange={(e) => setHostName(e.target.value)} /></label>
        <label>会议号<input value={roomId} onChange={(e) => setRoomId(e.target.value)} /></label>
        <label>开始时间<input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} /></label>
        <label>会议密码（可选）<input value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <div className="join-actions">
          <Link to="/" className="ghost-btn">返回首页</Link>
          <button type="button" className="primary-btn" onClick={onSubmit}>保存预约</button>
        </div>
      </section>
    </main>
  )
}

export default SchedulePage
