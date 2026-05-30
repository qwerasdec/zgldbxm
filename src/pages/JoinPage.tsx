import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getAuthUser } from '../utils/auth'

function JoinPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialCreateMode = searchParams.get('create') === '1'
  const authDisplayName = getAuthUser()?.displayName?.trim() || ''
  const defaultDisplayName = authDisplayName || '张同学'
  const [roomId, setRoomId] = useState(
    searchParams.get('room') ?? (initialCreateMode ? String(Date.now()).slice(-9) : '948245117'),
  )
  const [name, setName] = useState(defaultDisplayName)
  const [roomPassword, setRoomPassword] = useState('')
  const [showRoomPassword, setShowRoomPassword] = useState(false)
  const [createIfMissing, setCreateIfMissing] = useState(initialCreateMode)
  const [micReady, setMicReady] = useState(true)
  const [camReady, setCamReady] = useState(true)
  const [audioLevel, setAudioLevel] = useState(0)
  const [deviceTip, setDeviceTip] = useState('')
  const [joinTip, setJoinTip] = useState('')
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const previewStreamRef = useRef<MediaStream | null>(null)
  const joinDraftKey = 'join:draft:v1'

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {//这是一个 React 表单提交事件的处理函数，接收一个表单事件对象
    event.preventDefault()
    setJoinTip('')
    const normalizedRoom = roomId.trim().replace(/\s+/g, '')//用trim来完成去除空格
    //去除昵称中的前后空格
    const normalizedName = name.trim()
    //非空校验
    if (!normalizedRoom || !normalizedName) {
      setJoinTip('请先输入会议号与昵称。')
      return
    }
    try {
      localStorage.setItem(
        joinDraftKey,
        JSON.stringify({
          roomId: normalizedRoom,
          name: normalizedName,
          micReady,//是否开启麦克风
          camReady,//是否开启摄像头
          createIfMissing,//房间不存在时自动创建房间
          roomPassword: roomPassword.trim(),
          savedAt: Date.now(),
        }),
      )
    } catch {
      /* ignore */
    }
    navigate(
      `/meeting?room=${encodeURIComponent(normalizedRoom)}&name=${encodeURIComponent(normalizedName)}&mic=${micReady ? '1' : '0'}&cam=${camReady ? '1' : '0'}&pwd=${encodeURIComponent(roomPassword.trim())}&create=${createIfMissing ? '1' : '0'}`,
    )
  }
// 进入会议 joinPage.tsx 28-55
// 共享屏幕 MeetingPage.tsx 834-894
// 共享白板 MeetingPage.tsx 2024-2061
//文字转写 meetingpage.tsx 1887-1908
//录屏 meetingpage.tsx 1591-1638 回放 2474
//生成纪要导出 meetingpage.tsx 1498-1530 utils/ai.ts 46-52
//AI 对话问答 meetingPage.tsx 1475-1496
//主持人控场 meetingPage.tsx 1408-1448
//虚拟背景 meetingPage.tsx 482-523
//默认下载录屏与另存为 meetingPage.tsx 170-172 732-749
//私聊 type/meeting.ts 11-24 meetingPage.tsx 1322-1386
//预约会议 HistoryPage.tsx 64-106    SchedulePage.tsx 14
  useEffect(() => {
    try {
      const raw = localStorage.getItem(joinDraftKey)
      if (!raw) {
        return
      }
      const d = JSON.parse(raw) as Partial<{
        roomId: string
        name: string
        micReady: boolean
        camReady: boolean
        createIfMissing: boolean
        roomPassword: string
      }>
      if (typeof d.roomId === 'string' && !searchParams.get('room')) {
        setRoomId(d.roomId)
      }
      if (typeof d.name === 'string') {
        // 已登录时，默认昵称始终跟随当前账号显示名，不再被旧草稿覆盖
        setName(authDisplayName || d.name)
      } else {
        setName(defaultDisplayName)
      }
      if (typeof d.micReady === 'boolean') {
        setMicReady(d.micReady)
      }
      if (typeof d.camReady === 'boolean') {
        setCamReady(d.camReady)
      }
      if (typeof d.createIfMissing === 'boolean' && !searchParams.get('create')) {
        setCreateIfMissing(d.createIfMissing)
      }
      if (typeof d.roomPassword === 'string') {
        setRoomPassword(d.roomPassword)
      }
    } catch {
      /* ignore */
    }
  }, [authDisplayName, defaultDisplayName, searchParams])

  useEffect(() => {
    let audioContext: AudioContext | null = null
    let animationId = 0

    const setupPreview = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        previewStreamRef.current = stream
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream
        }

        const audioTrack = stream.getAudioTracks()[0]
        const videoTrack = stream.getVideoTracks()[0]
        if (audioTrack) {
          audioTrack.enabled = micReady
        }
        if (videoTrack) {
          videoTrack.enabled = camReady
        }

        audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 128
        source.connect(analyser)
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          analyser.getByteFrequencyData(dataArray)
          const avg = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length
          setAudioLevel(Math.min(100, Math.round((avg / 255) * 120)))
          animationId = requestAnimationFrame(updateLevel)
        }
        updateLevel()
      } catch {
        setDeviceTip('设备检测失败，请检查浏览器摄像头和麦克风权限。')
        setMicReady(false)
        setCamReady(false)
      }
    }

    void setupPreview()
    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId)
      }
      if (audioContext) {
        void audioContext.close()
      }
      previewStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    const stream = previewStreamRef.current
    if (!stream) {
      return
    }
    const audioTrack = stream.getAudioTracks()[0]
    const videoTrack = stream.getVideoTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = micReady
    }
    if (videoTrack) {
      videoTrack.enabled = camReady
    }
  }, [camReady, micReady])

  return (
    <main className="page join-page">
      <form className="join-card" onSubmit={handleJoin}>
        <h2>{createIfMissing ? '创建会议' : '加入会议'}</h2>
        <p>{createIfMissing ? '创建一个新的会议并立即进入。' : '输入会议号与昵称即可进入会议室。'}</p>
        <div className="join-mode-switch">
          <button
            type="button"
            className={`ghost-btn ${createIfMissing ? '' : 'active'}`}
            onClick={() => setCreateIfMissing(false)}
          >
            加入会议
          </button>
          <button
            type="button"
            className={`ghost-btn ${createIfMissing ? 'active' : ''}`}
            onClick={() => {
              setCreateIfMissing(true)
              if (!roomId.trim()) {
                setRoomId(String(Date.now()).slice(-9))
              }
            }}
          >
            创建会议
          </button>
        </div>
        <label>
          会议号
          <input
            type="text"
            placeholder={createIfMissing ? '将作为新会议号使用' : '例如：123456789'}
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
          />
        </label>
        <label>
          昵称
          <input
            type="text"
            placeholder="请输入你的姓名"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {createIfMissing ? (
          <label>
            创建会议密码（可选）
            <div className="join-password-row">
              <input
                type={showRoomPassword ? 'text' : 'password'}
                placeholder="可设置会议密码，成员加入时需输入"
                value={roomPassword}
                onChange={(event) => setRoomPassword(event.target.value)}
              />
              <button
                type="button"
                className="ghost-btn join-password-toggle"
                onClick={() => setShowRoomPassword((prev) => !prev)}
              >
                {showRoomPassword ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
        ) : (
          <label>
            会议密码（若主持人已设置）
            <div className="join-password-row">
              <input
                type={showRoomPassword ? 'text' : 'password'}
                placeholder="无密码可留空；有密码时建议在此填写以免漏填"
                value={roomPassword}
                onChange={(event) => setRoomPassword(event.target.value)}
              />
              <button
                type="button"
                className="ghost-btn join-password-toggle"
                onClick={() => setShowRoomPassword((prev) => !prev)}
              >
                {showRoomPassword ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
        )}
        <p className="join-mode-tip">
          {createIfMissing
            ? '将创建会议并把你设为主持人。'
            : '有密码时在此填写会随链接带入会议室；也可入会后在弹窗中输入。'}
        </p>
        <div className="mobile-join-tip">
          <strong>手机参会（iPhone）</strong>：请用 <strong>https</strong> 打开本站。若 Safari 提示「此连接非私人连接」→
          点<strong>显示详细信息</strong> → 最下面<strong>访问此网站</strong>。若没有该按钮，先用{' '}
          <code>
            {typeof window !== 'undefined'
              ? `http://${window.location.hostname}/ios-cert.crt`
              : 'http://你的IP/ios-cert.crt'}
          </code>{' '}
          安装证书并在「设置 → 证书信任设置」里信任，再访问 https。入会请与电脑使用<strong>同一会议号</strong>。
        </div>
        <div className="device-check-card">
          <video ref={previewVideoRef} className={`prejoin-video ${camReady ? '' : 'is-video-off'}`} autoPlay muted playsInline />
          {!camReady ? <div className="video-placeholder prejoin-placeholder">{name.slice(0, 1) || '匿'}</div> : null}
          <div className="device-actions">
            <button type="button" className="ghost-btn" onClick={() => setMicReady((prev) => !prev)}>
              {micReady ? '入会后麦克风开' : '入会后麦克风关'}
            </button>
            <button type="button" className="ghost-btn" onClick={() => setCamReady((prev) => !prev)}>
              {camReady ? '入会后摄像头开' : '入会后摄像头关'}
            </button>
          </div>
          <div className="audio-meter">
            <span>麦克风电平</span>
            <div className="audio-meter-track">
              <div className="audio-meter-fill" style={{ width: `${micReady ? audioLevel : 0}%` }} />
            </div>
          </div>
          {deviceTip ? <p className="device-tip">{deviceTip}</p> : null}
        </div>
        {joinTip ? <p className="device-tip">{joinTip}</p> : null}
        <div className="join-actions">
          <Link to="/" className="ghost-btn">
            返回首页
          </Link>
          <button type="submit" className="primary-btn">
            {createIfMissing ? '创建并进入' : '加入会议'}
          </button>
        </div>
      </form>
    </main>
  )
}

export default JoinPage
