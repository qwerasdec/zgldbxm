import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { io, Socket } from 'socket.io-client'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import RemoteVideo from '../components/RemoteVideo'
import { RTC_CONFIG, SIGNAL_SERVER_URL } from '../constants/meeting'
import type { ChatMessage, MeetingRecord, MemberState, RoomMessage, RoomMeta } from '../types/meeting'
import { askAiAssistant, generateAiSummary, runAiAgent } from '../utils/ai'
import { saveMeetingRecordRemote } from '../utils/storage'

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 仅音频轨道：对含视频的流录 timeslice 时，部分浏览器会抛 NotSupportedError */
function toAudioOnlyStream(stream: MediaStream): MediaStream {
  const tracks = stream.getAudioTracks().filter((track) => track.readyState === 'live')
  if (tracks.length === 0) {
    throw new Error('no-audio-track')
  }
  // 克隆 audio track，避免与 WebRTC/其它页面占用导致 “无法启动录音/NotReadableError”
  const cloned = tracks.map((track) => track.clone())
  return new MediaStream(cloned)
}

function createSttMediaRecorder(stream: MediaStream): { mr: MediaRecorder; mime: string } {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const mime of candidates) {
    if (!MediaRecorder.isTypeSupported(mime)) {
      continue
    }
    try {
      const mr = new MediaRecorder(stream, { mimeType: mime })
      return { mr, mime: mr.mimeType || mime }
    } catch {
      /* 尝试下一种 */
    }
  }
  const mr = new MediaRecorder(stream)
  return { mr, mime: mr.mimeType || 'audio/webm' }
}

async function saveBlobByPicker(blob: Blob, suggestedName: string): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: Function }).showSaveFilePicker
  if (!picker) {
    return false
  }
  const handle = await picker({
    suggestedName,
    types: [{ description: 'WebM 视频', accept: { 'video/webm': ['.webm'] } }],
  })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
  return true
}

type SpeechRecognitionResultItem = {
  transcript: string
}

type SpeechRecognitionResult = {
  isFinal: boolean
  0: SpeechRecognitionResultItem
}

type SpeechRecognitionEventLike = Event & {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResult>
}

type SpeechRecognitionErrorEvent = Event & { error?: string }

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** 将鼠标 CSS 坐标换算为 canvas 位图坐标（画布被 CSS 拉伸时与笔迹对齐） */
function whiteboardPointerCoords(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
) {
  const rect = canvas.getBoundingClientRect()
  const sx = canvas.width / rect.width
  const sy = canvas.height / rect.height
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  }
}

function MeetingPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const roomId = searchParams.get('room') ?? '948245117'
  const username = searchParams.get('name') ?? '匿名参会者'
  const initMicOn = (searchParams.get('mic') ?? '1') === '1'
  const initCamOn = (searchParams.get('cam') ?? '1') === '1'
  const initialPassword = searchParams.get('pwd') ?? ''
  const createIfMissing = (searchParams.get('create') ?? '0') === '1'

  const [micOn, setMicOn] = useState(initMicOn)
  const [camOn, setCamOn] = useState(initCamOn)
  const [members, setMembers] = useState<MemberState[]>([])
  const [localMemberId, setLocalMemberId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  /** 空字符串表示公聊；否则为对方 socket id */
  const [privateChatTargetId, setPrivateChatTargetId] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  /** AI 助手对话历史：role + content */
  const aiChatHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [agentGoal, setAgentGoal] = useState('')
  const [agentAnswer, setAgentAnswer] = useState('')
  const [agentPlan, setAgentPlan] = useState<string[]>([])
  const [agentReview, setAgentReview] = useState('')
  const [agentSteps, setAgentSteps] = useState<Array<{ tool: string; reason: string; output: string }>>([])
  /** 智能体对话历史 */
  const agentHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [aiSummary, setAiSummary] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [agentLoading, setAgentLoading] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  /** 文字转写识别中的临时文本（同时显示在会中消息区域底部） */
  const [transcribingPreview, setTranscribingPreview] = useState('')
  const [speechManual, setSpeechManual] = useState('')
  const [speechOn, setSpeechOn] = useState(false)
  /** 服务端 STT（硅基流动等），大陆可用；由挂载时拉取，不在此状态上禁用按钮避免「永远点不了」 */
  const [serverSttAvailable, setServerSttAvailable] = useState(false)
  /** 当前实际在用的转写通道，用于侧边栏提示文案 */
  const [activeSttMode, setActiveSttMode] = useState<'off' | 'server' | 'browser'>('off')
  const [speechSupported] = useState(
    typeof window !== 'undefined' &&
      Boolean(
        (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ||
          (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor })
            .webkitSpeechRecognition,
      ),
  )
  const [speaking, setSpeaking] = useState(false)
  const [permissionTip, setPermissionTip] = useState('')
  const [rtcTip, setRtcTip] = useState('')
  const [networkTip, setNetworkTip] = useState('连接中...')
  const [isSharingScreen, setIsSharingScreen] = useState(false)
  const [handRaised, setHandRaised] = useState(false)
  const [wasRemoved, setWasRemoved] = useState(false)
  const [joinFailed, setJoinFailed] = useState(false)
  const [showJoinPasswordModal, setShowJoinPasswordModal] = useState(false)
  const [joinPasswordInput, setJoinPasswordInput] = useState('')
  const [joinPasswordError, setJoinPasswordError] = useState('')
  const [roomMeta, setRoomMeta] = useState<RoomMeta>({
    locked: false,
    hasPassword: false,
    hostId: '',
    createdAt: Date.now(),
  })
  const [showWhiteboard, setShowWhiteboard] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [recording, setRecording] = useState(false)
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('dark')
  const [recordSaveMode, setRecordSaveMode] = useState<'download' | 'pick'>('download')
  const [recordSaveHint, setRecordSaveHint] = useState('浏览器下载（默认下载目录）')
  const [recordedVideoUrl, setRecordedVideoUrl] = useState('')
  const [recordedVideoName, setRecordedVideoName] = useState('')
  const [recordPlaybackRate, setRecordPlaybackRate] = useState(1)
  const [recordCurrentSec, setRecordCurrentSec] = useState(0)
  const [recordDurationSec, setRecordDurationSec] = useState(0)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedAudio, setSelectedAudio] = useState('')
  const [selectedVideo, setSelectedVideo] = useState('')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [virtualBgMode, setVirtualBgMode] = useState<'off' | 'blur' | 'image'>('off')
  const [virtualBgImage, setVirtualBgImage] = useState('')
  const [virtualBgStatus, setVirtualBgStatus] = useState<'off' | 'starting' | 'running' | 'error'>('off')
  const [virtualBgError, setVirtualBgError] = useState('')
  /** MediaPipe 不可用时的整画面 CSS 模糊（仅 blur 模式） */
  const [virtualBgSimpleBlur, setVirtualBgSimpleBlur] = useState(false)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const recordPlayerRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const isDrawingRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const speechRef = useRef<SpeechRecognitionLike | null>(null)
  const speechKeepAliveRef = useRef(false)
  /** 仅为字幕单独申请的麦克风流（与会中推流分离时需释放） */
  const speechMicStreamRef = useRef<MediaStream | null>(null)
  const sttMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const sttMimeRef = useRef('audio/webm')
  /** start(timeslice) 失败时，用 start()+定时 requestData 的兜底定时器 */
  const sttChunkTimerRef = useRef<number | null>(null)
  /** 录音分段：定时 stop 形成完整文件 */
  const sttStopTimerRef = useRef<number | null>(null)
  const sttPartsRef = useRef<Blob[]>([])
  /** startServerTranscription 里创建的音频流（克隆轨道），需显式 stop 释放麦克风 */
  const sttAudioStreamRef = useRef<MediaStream | null>(null)
  /** 避免多段音频并发请求导致 500/阻塞 */
  const sttInFlightRef = useRef(false)
  const analyserRafRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const persistedRef = useRef(false)
  const hasJoinedRoomRef = useRef(false)
  const joinedAtRef = useRef(0)
  const latestMessagesRef = useRef<ChatMessage[]>([])
  const latestMembersRef = useRef<MemberState[]>([])
  const latestRecordedVideoUrlRef = useRef('')
  const streamRef = useRef<MediaStream | null>(null)
  const screenTrackRef = useRef<MediaStreamTrack | null>(null)
  const virtualCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const virtualVideoRef = useRef<HTMLVideoElement | null>(null)
  const virtualPreviewRef = useRef<HTMLCanvasElement | null>(null)
  const virtualSegRef = useRef<any>(null)
  const virtualRafRef = useRef<number | null>(null)
  const virtualTrackRef = useRef<MediaStreamTrack | null>(null)
  const virtualBgImageElRef = useRef<HTMLImageElement | null>(null)
  const whiteboardPanelRef = useRef<HTMLElement | null>(null)
  const virtualBgModeRef = useRef<'off' | 'blur' | 'image'>('off')
  const virtualBgImageRef = useRef<string>('')
  const virtualGotFirstResultRef = useRef(false)
  const virtualCtorPromiseRef = useRef<Promise<any> | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const localMemberIdRef = useRef('')
  const joinPasswordRef = useRef(initialPassword)
  const clientKeyRef = useRef('')
  /** 最近一次私聊乐观插入的消息 id，失败时撤回 */
  const lastPrivateSentIdRef = useRef('')

  /** 按昵称隔离，避免同一浏览器里「别人」误用本会话缓存的会议密码 */
  const roomPwdKey = `meeting:pwd:${roomId}:user:${encodeURIComponent(username)}`
  const roomPwdLegacyKey = `meeting:pwd:${roomId}`
  const roomChatKey = `meeting:chat:${roomId}`
  const meetingPrefsKey = 'meeting:prefs:v1'

  const updateUrlPwd = (pwd: string) => {
    try {
      const url = new URL(window.location.href)
      if (pwd.trim()) {
        url.searchParams.set('pwd', pwd.trim())
      } else {
        url.searchParams.delete('pwd')
      }
      navigate(`${url.pathname}${url.search}`, { replace: true })
    } catch {
      /* ignore */
    }
  }

  const localMember = useMemo<MemberState>(
    () => ({
      id: localMemberId,
      name: username,
      micOn,
      camOn,
      isHost: members.some((member) => member.id === localMemberId && member.isHost),
      isSharingScreen,
      // 以服务端同步为准；本地 state 仅用于“立即反馈”，避免看起来同步了但其实没广播
      handRaised:
        members.find((m) => m.id === localMemberId)?.handRaised ?? handRaised,
    }),
    [camOn, handRaised, isSharingScreen, localMemberId, members, micOn, username],
  )

  const isHost = members.some((member) => member.id === localMemberId && member.isHost)
  const raisedMembers = useMemo(
    () =>
      members
        .filter((m) => m.handRaised)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  )
  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })

  const formatDuration = (seconds: number) => {
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
    const m = Math.floor(value / 60)
    const s = value % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  /** AI 与纪要仅使用公聊，避免把私聊内容发给模型 */
  const publicChatMessages = useMemo(
    () => messages.filter((item) => !item.isPrivate),
    [messages],
  )

  useEffect(() => {
    latestMessagesRef.current = messages
  }, [messages])

  useEffect(() => {
    latestMembersRef.current = members
  }, [members])

  useEffect(() => {
    latestRecordedVideoUrlRef.current = recordedVideoUrl
  }, [recordedVideoUrl])

  const persistMeetingRecord = (force = false) => {
    if (persistedRef.current) {
      return
    }
    if (!hasJoinedRoomRef.current) {
      return
    }
    const leftAt = Date.now()
    const joinedAt = joinedAtRef.current || leftAt
    const latestMessages = latestMessagesRef.current
    const latestMembers = latestMembersRef.current
    const durationSec = Math.max(0, Math.round((leftAt - joinedAt) / 1000))
    if (!force && durationSec < 3 && latestMessages.length === 0) {
      return
    }
    persistedRef.current = true
    const record: MeetingRecord = {
      roomId,
      username,
      joinedAt,
      leftAt,
      durationSec,
      messageCount: latestMessages.length,
      participantCount: latestMembers.length,
    }
    void saveMeetingRecordRemote(record)
  }

  useEffect(() => {
    // 1) 优先：URL pwd；2) 其次：本地缓存；避免刷新后再次弹密码
    const cachedPwd = (() => {
      try {
        const scoped = localStorage.getItem(roomPwdKey) ?? ''
        if (scoped) {
          return scoped
        }
        return localStorage.getItem(roomPwdLegacyKey) ?? ''
      } catch {
        return ''
      }
    })()
    joinPasswordRef.current = initialPassword.trim() || cachedPwd.trim()

    // 固定 clientKey：同一浏览器内必须用「会议号 + 昵称」隔离，否则会共用 v1 全局 key，
    // 服务端会把后来入会的人误判为「主持人 clientKey」而抢主持。
    const clientStorageKey = `meeting:clientKey:v2:${roomId}:${encodeURIComponent(username)}`
    try {
      let existing = localStorage.getItem(clientStorageKey)?.trim() ?? ''
      if (!existing && createIfMissing) {
        const legacy = localStorage.getItem('meeting:clientKey:v1')?.trim()
        if (legacy) {
          existing = legacy
          localStorage.removeItem('meeting:clientKey:v1')
        }
      }
      if (existing) {
        clientKeyRef.current = existing
        localStorage.setItem(clientStorageKey, existing)
      } else {
        const created =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`
        clientKeyRef.current = created
        localStorage.setItem(clientStorageKey, created)
      }
    } catch {
      clientKeyRef.current = ''
    }

    // 聊天记录已改为由服务端 chatLog 下发，不再从 localStorage 恢复

    // 恢复偏好设置
    try {
      const raw = localStorage.getItem(meetingPrefsKey)
      if (raw) {
        const prefs = JSON.parse(raw) as Partial<{
          themeMode: 'dark' | 'light'
          recordSaveMode: 'download' | 'pick'
          quality: 'low' | 'medium' | 'high'
          virtualBgMode: 'off' | 'blur' | 'image'
          virtualBgImage: string
        }>
        if (prefs.themeMode === 'dark' || prefs.themeMode === 'light') {
          setThemeMode(prefs.themeMode)
        }
        if (prefs.recordSaveMode === 'download' || prefs.recordSaveMode === 'pick') {
          setRecordSaveMode(prefs.recordSaveMode)
        }
        if (prefs.quality === 'low' || prefs.quality === 'medium' || prefs.quality === 'high') {
          setQuality(prefs.quality)
        }
        if (prefs.virtualBgMode === 'off' || prefs.virtualBgMode === 'blur' || prefs.virtualBgMode === 'image') {
          setVirtualBgMode(prefs.virtualBgMode)
        }
        if (typeof prefs.virtualBgImage === 'string') {
          setVirtualBgImage(prefs.virtualBgImage)
        }
      }
    } catch {
      /* ignore */
    }
  }, [createIfMissing, initialPassword, roomId, roomPwdKey, username])

  useEffect(() => {
    try {
      localStorage.setItem(roomChatKey, JSON.stringify(messages.slice(-200)))
    } catch {
      /* ignore */
    }
  }, [messages, roomChatKey])

  useEffect(() => {
    try {
      localStorage.setItem(
        meetingPrefsKey,
        JSON.stringify({
          themeMode,
          recordSaveMode,
          quality,
          virtualBgMode,
          virtualBgImage,
          savedAt: Date.now(),
        }),
      )
    } catch {
      /* ignore */
    }
  }, [quality, recordSaveMode, themeMode, virtualBgImage, virtualBgMode])

  useEffect(() => {
    virtualBgModeRef.current = virtualBgMode
  }, [virtualBgMode])

  useEffect(() => {
    virtualBgImageRef.current = virtualBgImage
    virtualBgImageElRef.current = null
  }, [virtualBgImage])

  const stopVirtualBackground = (opts?: { keepSimpleBlur?: boolean }) => {
    if (virtualRafRef.current !== null) {
      cancelAnimationFrame(virtualRafRef.current)
      virtualRafRef.current = null
    }
    virtualSegRef.current?.close?.()
    virtualSegRef.current = null
    virtualGotFirstResultRef.current = false
    if (virtualTrackRef.current) {
      try {
        virtualTrackRef.current.stop()
      } catch {
        /* ignore */
      }
    }
    virtualTrackRef.current = null
    if (!opts?.keepSimpleBlur) {
      setVirtualBgSimpleBlur(false)
      setVirtualBgStatus('off')
      setVirtualBgError('')
    }
  }

  const applySimpleBlurFallback = () => {
    setVirtualBgSimpleBlur(true)
    setVirtualBgStatus('running')
    setVirtualBgError('')
    setRtcTip('AI 抠图不可用，已改用整画面模糊（人像也会糊）。请确认 dist/mediapipe 完整后重选「背景模糊」。')
  }

    //虚拟背景依赖 MediaPipe（米滴呃派普）由谷歌开发的轻量，跨平台的人像分割模型
  const startVirtualBackground = async () => {//调用这个函数把之前运行的虚拟背景停下来防止多个处理循环导致页面卡顿
    // 避免重复启动导致多条 RAF 循环并存
    stopVirtualBackground()
    setVirtualBgStatus('starting')
    setVirtualBgError('')
    const localStream = streamRef.current//判断是否启动虚拟背景
    const cameraTrack = localStream?.getVideoTracks()[0]
    if (!localStream || !cameraTrack || isSharingScreen) {
      setVirtualBgStatus('error')
      setVirtualBgError('无法启动：未获取摄像头或正在共享屏幕')
      return
    }

    // 「背景模糊」「更换背景图」均走 MediaPipe 抠图；失败时才整画面 CSS 模糊
    const canvas = virtualCanvasRef.current
    const video = virtualVideoRef.current
    if (!canvas || !video) {
      return
    }

    // 自检 MediaPipe 静态资源（wasm 内嵌在 .js 里，不要探测 .wasm 文件）
    const probePaths = [
      '/mediapipe/selfie_segmentation/selfie_segmentation.js',
      '/mediapipe/selfie_segmentation/selfie_segmentation.binarypb',
    ]
    try {
      for (const path of probePaths) {
        const probe = await fetch(path, { method: 'HEAD', cache: 'no-store' })
        if (!probe.ok) {
          setRtcTip(
            `虚拟背景失败：模型资源不可访问（${path} ${probe.status}）。请确认 dist/mediapipe 已上传到服务器。`,
          )
          setVirtualBgStatus('error')
          setVirtualBgError(`资源不可访问：${path}`)
          return
        }
      }
    } catch {
      setRtcTip('虚拟背景失败：无法访问本地模型资源（请确认已上传 dist/mediapipe 目录）。')
      setVirtualBgStatus('error')
      setVirtualBgError('无法访问本地模型资源')
      return
    }

    // 用隐藏 video 播放原始摄像头流，逐帧处理后绘制到 canvas
    const raw = new MediaStream([cameraTrack])
    video.srcObject = raw
    try {
      await video.play()
    } catch {
      /* ignore */
    }

    // 等摄像头真正出帧，否则 mediapipe 会一直“无结果”
    const waitUntilReady = async () => {
      const start = Date.now()
      while (Date.now() - start < 2500) {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          return true
        }
        await new Promise((r) => setTimeout(r, 80))
      }
      return false
    }
    const ok = await waitUntilReady()
    if (!ok) {
      setRtcTip('虚拟背景失败：摄像头画面未就绪，请先开启摄像头后重试。')
      setVirtualBgStatus('error')
      setVirtualBgError('摄像头画面未就绪')
      return
    }

    const width = Math.max(320, Math.min(960, video.videoWidth || 960))
    const height = Math.max(240, Math.min(540, video.videoHeight || 540))
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    const locateMpFile = (file: string) => `/mediapipe/selfie_segmentation/${file}`

    type MpCtor = new (config?: { locateFile?: (f: string) => string }) => {
      setOptions: (o: { modelSelection?: number }) => void
      onResults: (cb: (results: unknown) => void) => void
      initialize: () => Promise<void>
      send: (input: { image: HTMLVideoElement }) => Promise<void>
      close: () => Promise<void>
    }

    const pickMpCtor = (): MpCtor | undefined =>
      (globalThis as unknown as { SelfieSegmentation?: MpCtor }).SelfieSegmentation

    const waitForMpCtor = (timeoutMs: number): Promise<MpCtor> =>
      new Promise((resolve, reject) => {
        const t0 = Date.now()
        const tick = () => {
          const Ctor = pickMpCtor()
          if (Ctor) {
            resolve(Ctor)
            return
          }
          if (Date.now() - t0 > timeoutMs) {
            reject(new Error('SelfieSegmentation-timeout'))
            return
          }
          window.setTimeout(tick, 80)
        }
        tick()
      })

    const loadSelfieSegmentationCtor = async (): Promise<MpCtor> => {
      virtualCtorPromiseRef.current = null
      const existing = pickMpCtor()
      if (existing) {
        return existing
      }
      if (!document.querySelector('script[data-mp-selfie-seg="1"]')) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.dataset.mpSelfieSeg = '1'
          script.src = locateMpFile('selfie_segmentation.js')
          script.async = false
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('mediapipe-script-load-failed'))
          document.head.appendChild(script)
        })
      }
      return waitForMpCtor(25000)
    }

    let SelfieSegmentationCtor: MpCtor
    try {
      SelfieSegmentationCtor = await loadSelfieSegmentationCtor()
    } catch (e) {
      if (virtualBgModeRef.current === 'blur') {
        applySimpleBlurFallback()
        return
      }
      const detail = e instanceof Error ? e.message : String(e)
      setRtcTip(
        `换图背景需要 AI 模型（${detail.slice(0, 80)}）。请整包上传 dist（含 mediapipe），并确认 index.html 里有 mediapipe 的 script。`,
      )
      setVirtualBgStatus('error')
      setVirtualBgError(detail.slice(0, 120))
      return
    }

    const seg = new SelfieSegmentationCtor({
      locateFile: locateMpFile,
    })
    seg.setOptions({ modelSelection: 1 })
    virtualSegRef.current = seg

    try {
      await seg.initialize()
    } catch (e) {
      virtualSegRef.current = null
      if (virtualBgModeRef.current === 'blur') {
        applySimpleBlurFallback()
        return
      }
      const detail = e instanceof Error ? e.message : String(e)
      setRtcTip(`换图背景初始化失败：${detail.slice(0, 120)}`)
      setVirtualBgStatus('error')
      setVirtualBgError(detail.slice(0, 120))
      return
    }

    seg.onResults((results: any) => {
      if (!results?.segmentationMask) {
        return
      }
      const first = !virtualGotFirstResultRef.current
      virtualGotFirstResultRef.current = true
      if (first) {
        setVirtualBgSimpleBlur(false)
        setRtcTip('虚拟背景已生效（人像清晰、仅背景虚化，左上角有 VB）。')
        setVirtualBgStatus('running')
        setVirtualBgError('')
      }
      ctx.save()
      ctx.clearRect(0, 0, width, height)

      const mode = virtualBgModeRef.current
      const bgUrl = virtualBgImageRef.current

      // 1) 先画 mask
      ctx.drawImage(results.segmentationMask, 0, 0, width, height)

      // 2) 用 source-in 画前景（人像）
      ctx.globalCompositeOperation = 'source-in'
      ctx.drawImage(results.image, 0, 0, width, height)

      // 3) 把背景垫到后面
      ctx.globalCompositeOperation = 'destination-over'
      if (mode === 'image' && bgUrl) {
        if (!virtualBgImageElRef.current) {
          const img = new Image()
          img.src = bgUrl
          virtualBgImageElRef.current = img
        }
        const img = virtualBgImageElRef.current
        if (img && img.complete) {
          ctx.drawImage(img, 0, 0, width, height)
        } else {
          ctx.fillStyle = '#1d2b4a'
          ctx.fillRect(0, 0, width, height)
        }
      } else if (mode === 'blur') {
        ctx.filter = 'blur(12px)'
        ctx.drawImage(results.image, 0, 0, width, height)
        ctx.filter = 'none'
      } else {
        ctx.drawImage(results.image, 0, 0, width, height)
      }

      // 4) 超明显角标（避免你看不到）
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(12, 12, 92, 40)
      ctx.fillStyle = '#fff'
      ctx.font = '24px system-ui, -apple-system, Segoe UI, Roboto'
      ctx.fillText('VB', 40, 42)
      ctx.restore()

      // 设置里预览用（小画布）
      const preview = virtualPreviewRef.current
      if (preview) {
        const pctx = preview.getContext('2d')
        if (pctx) {
          preview.width = 220
          preview.height = Math.round((220 * height) / width)
          pctx.clearRect(0, 0, preview.width, preview.height)
          pctx.drawImage(canvas, 0, 0, preview.width, preview.height)
        }
      }
    })

    const render = async () => {
      if (!virtualSegRef.current) {
        return
      }
      try {
        await virtualSegRef.current.send({ image: video })
      } catch (error) {
        stopVirtualBackground()
        const detail = error instanceof Error ? error.message : String(error ?? 'unknown')
        setRtcTip(`虚拟背景失败：${detail.slice(0, 180)}`)
        setVirtualBgStatus('error')
        setVirtualBgError(detail.slice(0, 220))
        return
      }
      virtualRafRef.current = requestAnimationFrame(() => void render())
    }
    void render()

    window.setTimeout(() => {
      if (virtualSegRef.current && !virtualGotFirstResultRef.current) {
        setRtcTip('虚拟背景加载中：若一直无 VB 标识，请打开浏览器控制台查看报错截图给我。')
        setVirtualBgStatus('starting')
      }
    }, 1800)

    window.setTimeout(() => {
      if (virtualSegRef.current && virtualGotFirstResultRef.current) {
        setRtcTip('虚拟背景已生效（画面左上角有 VB 标识）。')
      }
    }, 2300)

    const processedStream = canvas.captureStream(24)
    const processedTrack = processedStream.getVideoTracks()[0]
    if (!processedTrack) {
      setVirtualBgStatus('error')
      setVirtualBgError('无法获取处理后的视频轨道')
      return
    }
    virtualTrackRef.current = processedTrack
    replaceOutgoingVideoTrack(processedTrack)
    renegotiateAllPeers()

    // 本地预览也切成处理后（不影响共享屏幕）
    const composed = new MediaStream()
    const audioTrack = localStream.getAudioTracks()[0]
    composed.addTrack(processedTrack)
    if (audioTrack) {
      composed.addTrack(audioTrack)
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = composed
    }
  }
//当用户开启了 pick 模式时，会调用 saveBlobByPicker 这个封装好的函数
  const saveRecordBlob = async (blob: Blob, filename: string) => {
    if (recordSaveMode === 'pick') {
      try {//这个函数会弹出浏览器的 “另存为” 窗口，让用户自己选保存位置、改文件名
        const ok = await saveBlobByPicker(blob, filename)
        if (ok) {
          setRecordSaveHint('已通过“另存为”选择保存位置')
          return
        }
      } catch {
        setRtcTip('未选择保存位置，已回退到浏览器下载。')
      }
    }
    const a = document.createElement('a')
    const url = URL.createObjectURL(blob)
    a.href = url
    a.download = filename
    a.click()
    // 延迟 revoke，确保浏览器下载管理器已接管文件
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  useEffect(() => {
    if (recordSaveMode === 'pick') {
      setRecordSaveHint('每次录制结束会弹出“另存为”，可选择保存目录')
    } else {
      setRecordSaveHint('浏览器默认下载目录（无法由网页直接固定修改）')
    }
  }, [recordSaveMode])

  const flushPendingCandidates = async (peerId: string, connection: RTCPeerConnection) => {
    const queue = pendingCandidatesRef.current.get(peerId) ?? []
    pendingCandidatesRef.current.delete(peerId)
    for (const candidate of queue) {
      try {
        await connection.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (error) {
        console.warn(`[WebRTC] queued candidate failed for ${peerId}`, error)
      }
    }
  }

  const queuePendingCandidate = (peerId: string, candidate: RTCIceCandidateInit) => {
    const queue = pendingCandidatesRef.current.get(peerId) ?? []
    queue.push(candidate)
    pendingCandidatesRef.current.set(peerId, queue)
  }


  /** socket id 较小的一方发起 offer，避免双方同时 offer 或重连后无人 offer */
  const shouldInitiateOffer = (selfId: string, remoteId: string) =>
    Boolean(selfId && remoteId && selfId.localeCompare(remoteId) < 0)

  const scheduleOffer = (peerId: string, waitForStream = true) => {
    const tryOffer = (retries = 0) => {
      const selfId = localMemberIdRef.current
      if (!shouldInitiateOffer(selfId, peerId)) {
        return
      }
      if (waitForStream && !streamRef.current && retries < 15) {
        window.setTimeout(() => tryOffer(retries + 1), 200)
        return
      }
      void makeOffer(peerId)
    }
    window.setTimeout(() => tryOffer(), 300)
  }

  const attachRemoteTrack = (peerId: string, event: RTCTrackEvent) => {
    const track = event.track
    if (!track) {
      return
    }
    setRemoteStreams((prev) => {
      const existing = prev[peerId]
      if (existing) {
        if (!existing.getTracks().some((t) => t.id === track.id)) {
          existing.addTrack(track)
        }
        // Must create a new object reference so React detects the change and re-renders
        return { ...prev, [peerId]: new MediaStream(existing.getTracks()) }
      }
      const [fromEvent] = event.streams
      if (fromEvent) {
        return { ...prev, [peerId]: fromEvent }
      }
      return { ...prev, [peerId]: new MediaStream([track]) }
    })
  }

  const createPeerConnection = (peerId: string) => {
    const existing = peersRef.current.get(peerId)
    if (existing) {
      // 已有连接：补充可能缺失的音视频轨道
      const localStream = streamRef.current
      if (localStream) {
        const senders = existing.getSenders()
        const audioTrack = localStream.getAudioTracks()[0]
        const cameraTrack = localStream.getVideoTracks()[0]
        const currentVideoTrack = screenTrackRef.current ?? cameraTrack
        if (audioTrack && !senders.some((s) => s.track?.kind === 'audio')) {
          existing.addTrack(audioTrack, localStream)
        }
        if (currentVideoTrack && !senders.some((s) => s.track?.kind === 'video')) {
          existing.addTrack(currentVideoTrack, localStream)
        }
      }
      return existing
    }

    const connection = new RTCPeerConnection(RTC_CONFIG)
    peersRef.current.set(peerId, connection)

    const localStream = streamRef.current
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      const cameraTrack = localStream.getVideoTracks()[0]
      const currentVideoTrack = screenTrackRef.current ?? cameraTrack
      if (audioTrack) {
        connection.addTrack(audioTrack, localStream)
      }
      if (currentVideoTrack) {
        connection.addTrack(currentVideoTrack, localStream)
      }
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return
      }
      socketRef.current?.emit('signal', {
        roomId,
        targetId: peerId,
        signal: {
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        } satisfies RoomMessage,
      })
    }

    connection.ontrack = (event) => {
      console.warn(`[WebRTC] ontrack from ${peerId}: ${event.track.kind} ${event.track.readyState}`)
      attachRemoteTrack(peerId, event)
    }

    connection.onconnectionstatechange = () => {
      console.warn(`[WebRTC] conn state ${peerId}: ${connection.connectionState}`)
      if (connection.connectionState === 'failed') {
        setRtcTip('有成员连接失败，建议刷新页面后重试。')
      }
    }

    connection.oniceconnectionstatechange = () => {
      console.warn(`[WebRTC] ice state ${peerId}: ${connection.iceConnectionState}`)
      if (connection.iceConnectionState === 'failed') {
        setTimeout(() => {
          if (peersRef.current.get(peerId) === connection) {
            peersRef.current.delete(peerId)
            void makeOffer(peerId)
          }
        }, 2000)
      }
    }

    return connection
  }

  const makeOffer = async (targetId: string) => {
    try {
      const connection = createPeerConnection(targetId)
      const state = connection.signalingState
      if (state === 'have-local-offer' || state === 'have-remote-offer') {
        return
      }
      if (state !== 'stable') {
        return
      }
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      socketRef.current?.emit('signal', {
        roomId,
        targetId,
        signal: {
          type: 'offer',
          sdp: offer,
        } satisfies RoomMessage,
      })
    } catch (error) {
      console.warn('[WebRTC] makeOffer failed', error)
      setRtcTip('创建通话请求失败，请确认浏览器权限后重试。')
    }
  }
  //给所有远程 Peer 替换正在发送的视频轨道
  const replaceOutgoingVideoTrack = (newTrack: MediaStreamTrack) => {
    peersRef.current.forEach((connection) => {//存储所有和你建立 WebRTC 连接的远程 
      const videoSender = connection
        .getSenders()
        .find((sender) => sender.track && sender.track.kind === 'video')
      if (videoSender) {
        void videoSender.replaceTrack(newTrack)
      }
    })
  }

  const renegotiateAllPeers = () => {//通知所有 Peer 重新协商连接
    peersRef.current.forEach((_peer, peerId) => {
      void makeOffer(peerId)
    })
  }

  const stopScreenShare = () => {//停止屏幕共享，切回摄像头 / 虚拟背景
    const localStream = streamRef.current
    const cameraTrack = localStream?.getVideoTracks()[0]
    if (screenTrackRef.current) {
      screenTrackRef.current.onended = null
      screenTrackRef.current.stop()
      screenTrackRef.current = null
    }
    if (cameraTrack) {
      // 如果开了虚拟背景，优先恢复到虚拟背景轨道，否则恢复摄像头
      const nextTrack = virtualTrackRef.current ?? cameraTrack
      replaceOutgoingVideoTrack(nextTrack)
      renegotiateAllPeers()
      cameraTrack.enabled = camOn
      const fallbackStream = new MediaStream()
      const audioTrack = localStream?.getAudioTracks()[0]
      if (nextTrack) {
        fallbackStream.addTrack(nextTrack)
      }
      if (audioTrack) {
        fallbackStream.addTrack(audioTrack)
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = fallbackStream
      }
    }
    setIsSharingScreen(false)
    // 停止共享后，如果虚拟背景之前是开启的，自动恢复
    const prevMode = virtualBgModeRef.current
    if (prevMode !== 'off' && cameraTrack) {
      void startVirtualBackground()
    }
    socketRef.current?.emit('member-update', {
      roomId,
      micOn,
      camOn,
      isSharingScreen: false,
    })
  }

  const startScreenShare = async () => {
    try {
      // 共享屏幕时关闭虚拟背景，避免“摄像头处理轨道”干扰共享
      stopVirtualBackground()
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      })
      const displayTrack = displayStream.getVideoTracks()[0]
      if (!displayTrack) {
        return
      }
      screenTrackRef.current = displayTrack
      replaceOutgoingVideoTrack(displayTrack)
      renegotiateAllPeers()
      const localStream = streamRef.current
      const composedStream = new MediaStream()
      const audioTrack = localStream?.getAudioTracks()[0]
      composedStream.addTrack(displayTrack)
      if (audioTrack) {
        composedStream.addTrack(audioTrack)
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = composedStream
      }
      displayTrack.onended = () => {
        stopScreenShare()
      }
      setIsSharingScreen(true)
      socketRef.current?.emit('member-update', {
        roomId,
        micOn,
        camOn,
        isSharingScreen: true,
      })
    } catch {
      setRtcTip('屏幕共享启动失败，请重试并允许浏览器共享权限。')
    }
  }

  useEffect(() => {
    const setupLocalMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        })
        streamRef.current = stream
        const audioTrack = stream.getAudioTracks()[0]
        const videoTrack = stream.getVideoTracks()[0]
        if (audioTrack) {
          audioTrack.enabled = initMicOn
        }
        if (videoTrack) {
          videoTrack.enabled = initCamOn
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }
        // 本地流就绪后，若已有对端连接（socket 先于 getUserMedia 完成），
        // 重新发送 offer 以携带音视频轨道，修复远端看不到摄像头的问题。
        if (peersRef.current.size > 0) {
          peersRef.current.forEach((connection, peerId) => {
            if (connection.signalingState !== 'stable') {
              return
            }
            const localStream = streamRef.current
            if (!localStream) {
              return
            }
            const senders = connection.getSenders()
            const needAudio = localStream.getAudioTracks()[0] && !senders.some((s) => s.track?.kind === 'audio')
            const videoTrack = screenTrackRef.current ?? localStream.getVideoTracks()[0]
            const needVideo = videoTrack && !senders.some((s) => s.track?.kind === 'video')
            if (needAudio || needVideo) {
              void makeOffer(peerId)
            }
          })
        }
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audios = devices.filter((item) => item.kind === 'audioinput')
        const videos = devices.filter((item) => item.kind === 'videoinput')
        setAudioDevices(audios)
        setVideoDevices(videos)
        if (audios[0]) {
          setSelectedAudio(audios[0].deviceId)
        }
        if (videos[0]) {
          setSelectedVideo(videos[0].deviceId)
        }
      } catch {
        const needHttps =
          typeof window !== 'undefined' &&
          !window.isSecureContext &&
          window.location.hostname !== 'localhost'
        setPermissionTip(
          needHttps
            ? '当前为 http:// 访问，浏览器禁止使用摄像头/麦克风。请改用 https://本机IP/ 打开（服务器需先启用自签 HTTPS，见 DEPLOY-IP.md 第四节）。'
            : '未获取到摄像头或麦克风权限，当前以演示模式运行。',
        )
        setMicOn(false)
        setCamOn(false)
      }
    }

    void setupLocalMedia()
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [initCamOn, initMicOn])

  useEffect(() => {
    /** 不强制仅 websocket：部分网络/Vite 代理下长连失败会卡在「连接中」；允许先 polling 再升级更稳 */
    const socket = io(SIGNAL_SERVER_URL, {
      path: '/socket.io',
      reconnectionAttempts: 12,
      reconnectionDelay: 800,
      timeout: 20_000,
    })
    socketRef.current = socket

    const upsertMember = (member: MemberState) => {
      setMembers((prev) => {
        const withoutCurrent = prev.filter((item) => item.id !== member.id)
        return [...withoutCurrent, member]
      })
    }

    socket.on('connect_error', (err: Error) => {
      const msg = err?.message ?? String(err)
      setNetworkTip(`信令连接失败：${msg.slice(0, 120)}`)
      setRtcTip(
        '信令连不上时：①本机先运行 npm run signal ②页面使用 https://localhost:5173（npm run dev）。',
      )
    })

    socket.on('connect', () => {
      setNetworkTip('信令已连接，正在加入会议…')
      localMemberIdRef.current = socket.id ?? ''
      setLocalMemberId(socket.id ?? '')
      socket.emit('join-room', {
        roomId,
        name: username,
        password: joinPasswordRef.current,
        createIfMissing,
        clientKey: clientKeyRef.current,
      })
    })

    socket.on('disconnect', () => {
      setNetworkTip('连接已断开，正在重连...')
    })

    socket.on('reconnect_attempt', () => {
      setNetworkTip('网络波动，正在重连...')
    })

    socket.on(
      'room-members',
      ({
        members: roomMembers,
        selfId,
        roomMeta: incomingRoomMeta,
        chatLog: serverChatLog,
      }: {
        members: MemberState[]
        selfId: string
        roomMeta: RoomMeta
        chatLog?: ChatMessage[]
      }) => {
        if (!hasJoinedRoomRef.current) {
          hasJoinedRoomRef.current = true
          joinedAtRef.current = Date.now()
        }
        localMemberIdRef.current = selfId
        setLocalMemberId(selfId)
        setJoinFailed(false)
        setShowJoinPasswordModal(false)
        setJoinPasswordInput('')
        setJoinPasswordError('')
        setRtcTip((tip) => (tip === '正在校验会议密码...' ? '' : tip))
        latestMembersRef.current = [...roomMembers]
        setMembers([...roomMembers])
        setRoomMeta(incomingRoomMeta)

        // 用服务端 chatLog 替换本地消息，清除 localStorage 残留
        if (Array.isArray(serverChatLog) && serverChatLog.length > 0) {
          setMessages(serverChatLog.slice(-500))
        } else if (Array.isArray(serverChatLog)) {
          setMessages([])
        }
        try {
          localStorage.removeItem(roomChatKey)
        } catch {
          /* ignore */
        }

        // 入会成功：保存密码，刷新后自动携带
        const pwd = joinPasswordRef.current?.trim?.() ? String(joinPasswordRef.current).trim() : ''
        if (pwd) {
          try {
            localStorage.setItem(roomPwdKey, pwd)
            localStorage.removeItem(roomPwdLegacyKey)
          } catch {
            /* ignore */
          }
          updateUrlPwd(pwd)
        } else {
          try {
            localStorage.removeItem(roomPwdKey)
            localStorage.removeItem(roomPwdLegacyKey)
          } catch {
            /* ignore */
          }
          updateUrlPwd('')
        }
        // socket id 较小者向较大者发 offer，保证有且仅有一方发起
        roomMembers
          .filter((member) => member.id && member.id !== selfId)
          .forEach((member) => {
            scheduleOffer(member.id)
          })
      },
    )

    socket.on('join-error', ({ message }: { message: string }) => {
      const needPassword = message.includes('密码')
      if (needPassword) {
        setNetworkTip('信令已连接 · 待输入会议密码')
        setShowJoinPasswordModal(true)
        setJoinPasswordError(message.includes('错误') ? '密码错误，请重新输入。' : '')
        setRtcTip('该会议需要密码，请在弹窗中输入后加入。')
        return
      }
      setJoinFailed(true)
      setNetworkTip('信令已连接 · 未加入会议')
      setRtcTip(message)
    })

    socket.on('peer-joined', ({ member }: { member: MemberState }) => {
      upsertMember(member)
      const selfId = localMemberIdRef.current
      if (member.id && selfId && member.id !== selfId) {
        scheduleOffer(member.id)
      }
    })

    socket.on('member-update', ({ member }: { member: MemberState }) => {
      upsertMember(member)
    })

    socket.on(
      'host-changed',
      ({ members: allMembers }: { hostId: string; members: MemberState[] }) => {
        setMembers(allMembers)
      },
    )

    socket.on('room-meta', (meta: RoomMeta) => {
      setRoomMeta(meta)
    })

    socket.on('member-left', ({ id }: { id: string }) => {
      setMembers((prev) => prev.filter((member) => member.id !== id))
      setPrivateChatTargetId((target) => (target === id ? '' : target))
      setRemoteStreams((prev) => {
        const clone = { ...prev }
        delete clone[id]
        return clone
      })
      pendingCandidatesRef.current.delete(id)
      const connection = peersRef.current.get(id)
      connection?.close()
      peersRef.current.delete(id)
    })

    socket.on('chat-message', (message: ChatMessage) => {
      setMessages((prev) => [...prev, message])
    })

    socket.on('private-chat-message', (message: ChatMessage) => {
      if (!message?.isPrivate || !message.fromId || !message.toId) {
        return
      }
      const selfId = localMemberIdRef.current
      if (selfId && message.toId !== selfId && message.fromId !== selfId) {
        return
      }
      if (
        message.id === lastPrivateSentIdRef.current &&
        message.fromId === localMemberIdRef.current
      ) {
        lastPrivateSentIdRef.current = ''
      }
      setMessages((prev) => {
        if (prev.some((m) => m.id === message.id)) {
          return prev.map((m) => (m.id === message.id ? { ...m, ...message } : m))
        }
        return [...prev, message]
      })
    })

    socket.on('private-chat-error', ({ message }: { message: string }) => {
      const doomed = lastPrivateSentIdRef.current
      if (doomed) {
        setMessages((prev) => prev.filter((m) => m.id !== doomed))
        lastPrivateSentIdRef.current = ''
      }
      setRtcTip(message)
      setPrivateChatTargetId('')
    })

    socket.on(
      'whiteboard-draw',
      (stroke: { x0: number; y0: number; x1: number; y1: number; color: string }) => {
        const canvas = canvasRef.current
        if (!canvas) {
          return
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          return
        }
        ctx.strokeStyle = stroke.color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(stroke.x0, stroke.y0)
        ctx.lineTo(stroke.x1, stroke.y1)
        ctx.stroke()
      },
    )

    socket.on('whiteboard-clear', () => {
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    })

    socket.on('force-mute', () => {
      setMicOn(false)
    })

    socket.on('removed-by-host', () => {
      setWasRemoved(true)
      setRtcTip('你已被主持人移出会议。')
      socket.disconnect()
      peersRef.current.forEach((peer) => peer.close())
      peersRef.current.clear()
    })

    socket.on('signal', async ({ fromId, signal }: { fromId: string; signal: RoomMessage }) => {
      const connection = createPeerConnection(fromId)
      try {
        if (signal.type === 'offer') {
          await connection.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          const answer = await connection.createAnswer()
          await connection.setLocalDescription(answer)
          socket.emit('signal', {
            roomId,
            targetId: fromId,
            signal: {
              type: 'answer',
              sdp: answer,
            } satisfies RoomMessage,
          })
          await flushPendingCandidates(fromId, connection)
        } else if (signal.type === 'answer') {
          if (connection.signalingState !== 'have-local-offer') {
            return
          }
          await connection.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          await flushPendingCandidates(fromId, connection)
        } else if (signal.type === 'candidate') {
          if (!connection.remoteDescription) {
            queuePendingCandidate(fromId, signal.candidate)
            return
          }
          await connection.addIceCandidate(new RTCIceCandidate(signal.candidate))
        }
      } catch (error) {
        console.warn('[WebRTC] signal handling failed', error)
        setRtcTip('实时连接协商失败，可尝试重新加入会议。')
      }
    })

    return () => {
      peersRef.current.forEach((peer) => peer.close())
      peersRef.current.clear()
      socket.disconnect()
    }
  }, [createIfMissing, roomId, username])

  useEffect(() => {
    const stream = streamRef.current
    if (!stream) {
      return
    }
    const audioTrack = stream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = micOn
    }
    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = camOn
    }
    socketRef.current?.emit('member-update', {
      roomId,
      micOn,
      camOn,
      isSharingScreen,
      handRaised,
    })
  }, [camOn, handRaised, isSharingScreen, micOn, roomId])

  useEffect(() => {
    const stream = streamRef.current
    if (!stream) {
      return
    }
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) {
      return
    }
    // 先关闭旧的 AudioContext，避免快速重渲染时泄露
    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }
    const audioContext = new AudioContext()
    audioContextRef.current = audioContext
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]))
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(data)
      const avg = data.reduce((sum, value) => sum + value, 0) / data.length
      setSpeaking(avg > 18)
      analyserRafRef.current = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      if (analyserRafRef.current) {
        cancelAnimationFrame(analyserRafRef.current)
      }
      void audioContext.close()
      audioContextRef.current = null
      setSpeaking(false)
    }
  }, [micOn, roomId])

  useEffect(() => {
    const ac = new AbortController()
    void fetch(`${SIGNAL_SERVER_URL}/api/stt/status`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { enabled?: boolean }) => setServerSttAvailable(Boolean(d.enabled)))
      .catch(() => setServerSttAvailable(false))
    return () => ac.abort()
  }, [])

  useEffect(
    () => () => {
      if (screenTrackRef.current) {
        screenTrackRef.current.stop()
      }
      stopVirtualBackground()
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
      speechKeepAliveRef.current = false
      speechRef.current?.stop()
      try {
        const mr = sttMediaRecorderRef.current
        if (mr && mr.state !== 'inactive') {
          mr.stop()
        }
      } catch {
        /* ignore */
      }
      sttMediaRecorderRef.current = null
      if (sttChunkTimerRef.current !== null) {
        window.clearInterval(sttChunkTimerRef.current)
        sttChunkTimerRef.current = null
      }
      speechMicStreamRef.current?.getTracks().forEach((track) => track.stop())
      speechMicStreamRef.current = null
      if (latestRecordedVideoUrlRef.current) {
        URL.revokeObjectURL(latestRecordedVideoUrlRef.current)
      }
      persistMeetingRecord()
    },
    [],
  )

  const sendChatMessage = () => {
    const text = chatInput.trim()
    if (!text) {//查看有没有内容没有就不会发送
      return
    }
    const socket = socketRef.current
    if (!socket?.connected) {//再判断 WebSocket 连接是否正常，如果没连上，提示用户等连接成功再发
      setRtcTip('信令未连接，请等待顶部显示「连接成功」后再发送。')
      return
    }//最后判断用户自己的成员 ID 是否同步完成，没同步好的话也不能发消息
    const selfId = localMemberIdRef.current
    if (!selfId) {
      setRtcTip('仍在同步成员身份，请约 1 秒后再试发送。')
      return
    }//如果用户当前选择了私聊对象，就去成员列表里找这个对象
    if (privateChatTargetId) {
      // 必须用当前 render 的 members：latestMembersRef 在 setMembers 后可能晚一拍未更新，会导致误判「对方不在」或发不出去
      const peer = members.find((m) => m.id === privateChatTargetId)
      if (!peer || peer.id === selfId) {
        setRtcTip('私聊对象已离开或无效，已切回公聊。')
        setPrivateChatTargetId('')
        return
      }
      const toId = String(privateChatTargetId)
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        sender: username,
        text,
        createdAt: Date.now(),//消息发送的时间戳
        isPrivate: true,//标记这是一条私聊消息
        fromId: selfId,//发送者的 Socket ID
        toId,//接收者的 Socket ID
        toName: peer.name,
      }
      lastPrivateSentIdRef.current = message.id
      setMessages((prev) => [...prev, message])
      setChatInput('')
      socket.emit(//调用 WebSocket 发送事件 private-chat-message，把房间号和消息对象发给服务器
        'private-chat-message',
        { roomId, message },
        (res: { ok?: boolean; error?: string } | undefined) => {
          if (res?.ok === true) {
            lastPrivateSentIdRef.current = ''
            return
          }//发送成功：清空消息 ID 记录，流程结束
          if (res?.ok === false) {
            setMessages((prev) => prev.filter((m) => m.id !== message.id))
            lastPrivateSentIdRef.current = ''
            setChatInput(text)//从本地聊天列表里删掉刚才添加的消息，把用户输入的文字放回输入框，并提示用户发送失败
            setRtcTip(typeof res.error === 'string' && res.error ? res.error : '私聊发送失败，请重试。')
          }
        },
      )
      return
    }
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      sender: username,
      text,
      createdAt: Date.now(),
    }
    socket.emit('chat-message', { roomId, message })
    setChatInput('')
  }

  const remoteMembers = members
    .filter((member) => member.id !== localMemberId)
    .sort((a, b) => a.name.localeCompare(b.name))

  /** 下拉框里若仍保留已离线的 socket id，会导致选中的私聊对象无效、对方收不到 */
  useEffect(() => {
    if (!privateChatTargetId) {
      return
    }
    const selfId = localMemberIdRef.current
    const stillThere = members.some((m) => m.id === privateChatTargetId && m.id !== selfId)
    if (!stillThere) {
      setPrivateChatTargetId('')
    }
  }, [members, privateChatTargetId])

  // 白板 canvas 自适应容器宽度
  useEffect(() => {
    if (!showWhiteboard) {
      return
    }
    const panel = whiteboardPanelRef.current
    const canvas = canvasRef.current
    if (!panel || !canvas) {
      return
    }
    const resize = () => {
      const width = Math.max(320, panel.clientWidth - 32)
      const height = Math.round(width * 0.35)
      canvas.width = width
      canvas.height = height
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [showWhiteboard])

  const sharedRemoteMember = remoteMembers.find(
    (member) => member.isSharingScreen && remoteStreams[member.id],
  )
  const showSharedLayout = isSharingScreen || Boolean(sharedRemoteMember)

  const removeMember = (targetId: string) => {//只有主持人才能点击这个按钮
    if (!isHost) {
      return
    }//主持人点击一处参会人，代码把ID和用户名发送给服务器随后服务器进行踢出
    socketRef.current?.emit('host-remove-member', { roomId, targetId })
  }
  //全员静音
  const muteAll = () => {
    if (!isHost) {
      return
    }
    socketRef.current?.emit('host-mute-all', { roomId })
  }
  //锁定会议/解除
  const toggleLock = () => {
    if (!isHost) {
      return
    }
    socketRef.current?.emit('host-set-room-lock', {
      roomId,
      locked: !roomMeta.locked,
    })
  }
  //修改会议密码
  const updateRoomPassword = () => {
    if (!isHost) {
      return
    }
    socketRef.current?.emit('host-set-password', {
      roomId,
      password: passwordDraft,
    })
  }
  //只有主持人才能点击，主持人点击后把目标用户的ID发送给服务器，服务器把主持人身份给这个人
  const transferHost = (targetId: string) => {
    if (!isHost) {
      return
    }
    socketRef.current?.emit('host-transfer', { roomId, targetId })
  }

  const exportChat = () => {
    const selfId = localMemberIdRef.current
    const content = messages
      .map((item) => {
        let tag = ''
        if (item.isPrivate && item.fromId && item.toId) {
          if (item.fromId === selfId) {
            tag = `[私聊→${item.toName ?? '对方'}] `
          } else {
            tag = '[私聊] '
          }
        }
        return `${formatTime(item.createdAt)} ${tag}${item.sender}: ${item.text}`
      })
      .join('\n')
    const blob = new Blob([content || '暂无聊天记录'], {
      type: 'text/plain;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chat-${roomId}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const askAi = async () => {
    const prompt = aiPrompt.trim()
    if (!prompt) {
      return
    }
    setAiLoading(true)
    try {
      const history = aiChatHistoryRef.current
      const { answer, degraded, detail } = await askAiAssistant({
        roomId,
        username,
        prompt,
        messages: publicChatMessages,
        history,
      })
      const extra = degraded && detail?.trim() ? `\n\n【排障】${detail.trim()}` : ''
      const finalAnswer = `${answer}${extra}`
      setAiAnswer(finalAnswer)
      // 保存到对话历史
      const newHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...history,
        { role: 'user', content: prompt },
        { role: 'assistant', content: finalAnswer },
      ]
      aiChatHistoryRef.current = newHistory.slice(-20) // 保留最近 20 轮
      setAiPrompt('')
    } catch (error) {
      setRtcTip(error instanceof Error ? error.message : 'AI 助手调用失败')
    } finally {
      setAiLoading(false)
    }
  }

  const createSummary = async () => {
    setSummaryLoading(true)
    try {
      const { summary, degraded, detail } = await generateAiSummary({//这是封装好的Ai接口
        roomId,
        username,
        messages: publicChatMessages,
        members,
      })//如果 AI 服务压力大、用了简化模型，会把排障信息拼接到纪要后面，方便用户知道情况
      const extra = degraded && detail?.trim() ? `\n\n【排障】${detail.trim()}` : ''
      const text = summary?.trim() ? `${summary.trim()}${extra}` : '模型返回了空结果，请稍后重试。'
      setAiSummary(text)
    } catch (error) {
      setRtcTip(error instanceof Error ? error.message : '会议纪要生成失败')
    } finally {
      setSummaryLoading(false)
    }
  }

  const runAgentMvp = async () => {
    const goal = agentGoal.trim()
    if (!goal) {
      setRtcTip('请先输入智能体目标。')
      return
    }
    setAgentLoading(true)
    try {
      const history = agentHistoryRef.current
      const data = await runAiAgent({
        roomId,
        username,
        goal,
        messages: publicChatMessages,
        members,
        history,
      })
      setAgentAnswer(data.answer ?? '')
      setAgentPlan(Array.isArray(data.plan) ? data.plan : [])
      setAgentSteps(Array.isArray(data.steps) ? data.steps : [])
      setAgentReview(typeof data.review === 'string' ? data.review : '')
      // 保存到对话历史
      const answerText = data.answer ?? ''
      const newHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...history,
        { role: 'user', content: `目标：${goal}` },
        { role: 'assistant', content: answerText },
      ]
      agentHistoryRef.current = newHistory.slice(-20)
      setAgentGoal('')
      if (data.degraded) {
        setRtcTip(`智能体已降级输出：${data.detail ?? '请检查 AI 配置'}`)
      }
    } catch (error) {
      setRtcTip(error instanceof Error ? error.message : '智能体执行失败')
    } finally {
      setAgentLoading(false)
    }
  }

  const exportSummary = () => {
    const content = aiSummary.trim()
    if (!content) {
      setRtcTip('请先生成会后纪要')
      return
    }//把纪要文本转换成浏览器能识别的 “文件对象”，指定为 UTF-8 编码，避免中文乱码
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `summary-${roomId}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const copyInviteLink = async () => {
    const invite = `${window.location.origin}/join?room=${roomId}`
    try {
      await navigator.clipboard.writeText(invite)
      setRtcTip('邀请链接已复制')
    } catch {
      setRtcTip(`请手动复制邀请链接：${invite}`)
    }
  }

  const applyDeviceSettings = async () => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedAudio ? { deviceId: { exact: selectedAudio } } : true,
        video: selectedVideo
          ? {
              deviceId: { exact: selectedVideo },
              width: quality === 'high' ? 1280 : quality === 'medium' ? 960 : 640,
              height: quality === 'high' ? 720 : quality === 'medium' ? 540 : 360,
              frameRate: quality === 'high' ? 30 : quality === 'medium' ? 24 : 15,
            }
          : true,
      }
      const newStream = await navigator.mediaDevices.getUserMedia(constraints)
      if (virtualBgMode !== 'off' && !isSharingScreen) {
        stopVirtualBackground()
      }
      setVirtualBgSimpleBlur(false)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = newStream
      const audioTrack = newStream.getAudioTracks()[0]
      const videoTrack = newStream.getVideoTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = micOn
      }
      if (videoTrack) {
        videoTrack.enabled = camOn
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = newStream
      }
      peersRef.current.forEach((connection) => {
        connection.getSenders().forEach((sender) => {
          if (sender.track?.kind === 'audio' && audioTrack) {
            void sender.replaceTrack(audioTrack)
          }
          if (sender.track?.kind === 'video' && videoTrack) {
            void sender.replaceTrack(videoTrack)
          }
        })
      })
      if (virtualBgMode !== 'off' && !isSharingScreen) {
        await startVirtualBackground()
        setRtcTip('设备设置已应用。')
      } else {
        setRtcTip('设备设置已应用')
      }
      setShowSettings(false)
    } catch {
      setRtcTip('设备切换失败，请检查设备是否可用。')
    }
  }
  //开始录制：先拿到屏幕和声音
  const startRecording = async () => {
    try {//调用浏览器自带的录屏 API，弹出窗口让你选择要录制的屏幕 / 窗口 / 标签页
      const pageStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      })
      recordingStreamRef.current = pageStream
      recordingChunksRef.current = []//录屏的数组容器把录屏中每一小段视频数据像收集碎片一样
      const recorder = new MediaRecorder(pageStream, {//浏览器自带的工具
        mimeType: 'video/webm;codecs=vp8,opus',
      })
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {//录屏过程中不断收集碎片
          recordingChunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => {//录屏完成后把碎片拼成完整的录屏并保存
        const blob = new Blob(recordingChunksRef.current, {//把所有的碎片拼成一个完整的Blob视频文件
          type: 'video/webm',//随后生成后缀名为webm的文件
        })
        const filename = `record-${roomId}-${Date.now()}.webm`
        // Use ref to get the latest URL (state value captured by closure may be stale)
        if (latestRecordedVideoUrlRef.current) {
          URL.revokeObjectURL(latestRecordedVideoUrlRef.current)
        }
        const url = URL.createObjectURL(blob)
        setRecordedVideoUrl(url)
        setRecordedVideoName(filename)
        void saveRecordBlob(blob, filename)
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        setRecording(false)
        setRtcTip('录制已结束：已保存，并可在右侧播放器回放。')
      }
      recorder.start(500)
      setRecording(true)
      setRtcTip('录制已开始，请在弹窗中选择“当前标签页/窗口”。')
      const firstTrack = pageStream.getVideoTracks()[0]
      if (firstTrack) {
        firstTrack.onended = () => {
          stopRecording()
        }
      }
    } catch {
      setRtcTip('录制启动失败，请允许屏幕捕获后重试。')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  const stopSpeechEngines = () => {
    speechKeepAliveRef.current = false
    speechRef.current?.stop()
    speechRef.current = null
    if (sttChunkTimerRef.current !== null) {
      window.clearInterval(sttChunkTimerRef.current)
      sttChunkTimerRef.current = null
    }
    if (sttStopTimerRef.current !== null) {
      window.clearInterval(sttStopTimerRef.current)
      sttStopTimerRef.current = null
    }

    const mr = sttMediaRecorderRef.current
    const stoppingRecorder = Boolean(mr && mr.state !== 'inactive')

    try {
      if (stoppingRecorder && mr) {
        mr.stop()
        // 尾段上传与释放麦克风在 mr.onstop（startServerTranscription 内注册）里完成，避免同步清空缓冲导致丢尾包
      }
    } catch {
      /* ignore */
    }

    if (!stoppingRecorder) {
      sttPartsRef.current = []
      sttMediaRecorderRef.current = null
      sttAudioStreamRef.current?.getTracks().forEach((track) => track.stop())
      sttAudioStreamRef.current = null
      const dedicated = speechMicStreamRef.current
      if (dedicated && dedicated !== streamRef.current) {
        dedicated.getTracks().forEach((track) => track.stop())
      }
      speechMicStreamRef.current = null
    }

    setSpeechOn(false)
    setTranscribingPreview('')
    setActiveSttMode('off')
  }

  const startServerTranscription = async () => {
    let stream: MediaStream | null = streamRef.current
    const live = stream?.getAudioTracks().some((track) => track.readyState === 'live')
    if (!live) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        speechMicStreamRef.current = stream
      } catch {
        setRtcTip('需要麦克风权限才能使用文字转写。')
        return
      }
    }

    if (!stream) {
      setRtcTip('无法获取麦克风。')
      return
    }

    /** 上传一段「完整可解码」的 WebM/Opus；过小则跳过（静音段） */
    const postSttBlob = async (blob: Blob) => {
      if (blob.size < 1_200) {
        return
      }
      if (sttInFlightRef.current) {
        return
      }
      sttInFlightRef.current = true
      setTranscribingPreview('…识别中')
      try {
        const ab = await blob.arrayBuffer()
        const b64 = arrayBufferToBase64(ab)
        const res = await fetch(`${SIGNAL_SERVER_URL}/api/stt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: b64, mimeType: sttMimeRef.current }),
        })
        const bodyText = await res.text().catch(() => '')
        if (!res.ok) {
          setTranscribingPreview('')
          const errJson = (() => {
            try {
              return JSON.parse(bodyText) as { error?: { message?: string } }
            } catch {
              return null
            }
          })()
          const short =
            errJson?.error?.message?.includes('end of stream') || bodyText.includes('end of stream')
              ? '音频片段不完整（请勿拼接 timeslice 小片段上传）。已自动改为整段录制。若仍失败请稍后再试。'
              : bodyText.slice(0, 160)
          setRtcTip(`服务端转写：${res.status} ${short}`)
          return
        }
        const data = (bodyText ? (JSON.parse(bodyText) as { text?: string; error?: string }) : {}) as {
          text?: string
          error?: string
        }
        setTranscribingPreview('')
        if (data.text?.trim()) {
          const message: ChatMessage = {
            id: crypto.randomUUID(),
            sender: `${username}(文字转写)`,
            text: data.text.trim(),
            createdAt: Date.now(),
          }
          socketRef.current?.emit('chat-message', { roomId, message })
        } else if (data.error) {
          setRtcTip(`服务端转写：${data.error}`)
        }
      } catch {
        setTranscribingPreview('')
        setRtcTip('服务端转写请求失败，请确认信令已启动且已配置 STT_API_KEY。')
      } finally {
        sttInFlightRef.current = false
      }
    }

    /**
     * 服务端 STT 需要「完整容器」的短录音：用 stop() 收尾再上传。
     * 反复在同一克隆流上 start 易失败，因此每段结束后释放该段流，再从会议麦克风流重新 clone 开启下一段。
     */
    const segmentPartsRef = { current: [] as Blob[] }
    let segmentStream: MediaStream = new MediaStream()

    const endSegmentStream = () => {
      segmentStream.getTracks().forEach((track) => track.stop())
      if (sttAudioStreamRef.current === segmentStream) {
        sttAudioStreamRef.current = null
      }
      segmentStream = new MediaStream()
    }

    const beginSegment = (): boolean => {
      let src = streamRef.current
      const live = src?.getAudioTracks().some((track) => track.readyState === 'live')
      if (!live) {
        src = speechMicStreamRef.current
      }
      if (!src?.getAudioTracks().some((track) => track.readyState === 'live')) {
        setRtcTip('麦克风已断开，文字转写已停止。')
        stopSpeechEngines()
        return false
      }
      try {
        segmentStream = toAudioOnlyStream(src)
      } catch {
        setRtcTip('当前没有可用的麦克风音轨，文字转写已停止。')
        stopSpeechEngines()
        return false
      }
      sttAudioStreamRef.current = segmentStream
      segmentPartsRef.current = []

      let mr: MediaRecorder
      try {
        const created = createSttMediaRecorder(segmentStream)
        mr = created.mr
        sttMimeRef.current = created.mime
      } catch {
        setRtcTip('当前浏览器不支持 MediaRecorder 录音，请使用 Chrome / Edge 最新版。')
        stopSpeechEngines()
        return false
      }

      sttMediaRecorderRef.current = mr
      mr.ondataavailable = (ev) => {
        if (!speechKeepAliveRef.current || ev.data.size < 1) {
          return
        }
        segmentPartsRef.current.push(ev.data)
      }
      mr.onerror = () => {
        setRtcTip('录音异常，文字转写已停止。')
        stopSpeechEngines()
      }
      mr.onstop = () => {
        const parts = segmentPartsRef.current
        segmentPartsRef.current = []
        const blob = new Blob(parts, { type: sttMimeRef.current })
        endSegmentStream()
        void postSttBlob(blob).finally(() => {
          if (!speechKeepAliveRef.current) {
            sttMediaRecorderRef.current = null
            const dedicated = speechMicStreamRef.current
            if (dedicated && dedicated !== streamRef.current) {
              dedicated.getTracks().forEach((track) => track.stop())
            }
            speechMicStreamRef.current = null
            return
          }
          window.setTimeout(() => {
            if (!speechKeepAliveRef.current) {
              return
            }
            if (!beginSegment()) {
              return
            }
            try {
              sttMediaRecorderRef.current?.start()
            } catch {
              setRtcTip('无法启动下一段录音，文字转写已停止。')
              stopSpeechEngines()
            }
          }, 0)
        })
      }
      return true
    }

    speechKeepAliveRef.current = true
    if (!beginSegment()) {
      return
    }
    try {
      sttMediaRecorderRef.current?.start()
    } catch {
      setRtcTip('无法启动录音，请关闭其它占用麦克风的应用后重试。')
      stopSpeechEngines()
      return
    }

    const segmentMs = 6000
    sttStopTimerRef.current = window.setInterval(() => {
      const mr = sttMediaRecorderRef.current
      if (!speechKeepAliveRef.current || !mr || mr.state !== 'recording') {
        return
      }
      try {
        mr.stop()
      } catch {
        /* ignore */
      }
    }, segmentMs)

    setSpeechOn(true)
    setActiveSttMode('server')
    setRtcTip('已开启文字转写')
  }

  const toggleSpeech = async () => {//看看是否开着如果开着就关闭如果没开就开启
    if (speechOn) {
      stopSpeechEngines()
      return
    }

    let useServer = serverSttAvailable
    if (!useServer) {
      try {//选择那种转文字服务器还是本地？
        const r = await fetch(`${SIGNAL_SERVER_URL}/api/stt/status`)
        const d = (await r.json()) as { enabled?: boolean }
        useServer = Boolean(d.enabled)
        setServerSttAvailable(useServer)
      } catch {
        useServer = false
      }
    }

    if (useServer) {//决定用服务器转文字的话，就启动服务器模式，随后麦克风会自动传到服务器服务器帮你转换为文字
      await startServerTranscription()
      return
    }

    if (!speechSupported) {
      setRtcTip(
        '当前无法使用文字转写：请在项目 .env 中配置 STT_API_KEY（推荐硅基流动 api.siliconflow.cn），重启信令后再试；或换可访问谷歌语音的浏览器环境。',
      )
      return
    }

    const ctor =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor })
        .webkitSpeechRecognition
    if (!ctor) {
      setRtcTip('当前浏览器不支持浏览器内置转写，请配置服务端 STT_API_KEY。')
      return
    }

    const meetingAudioLive = streamRef.current
      ?.getAudioTracks()
      .some((track) => track.readyState === 'live')
    if (!meetingAudioLive) {
      try {
        speechMicStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        setRtcTip('需要麦克风权限才能使用文字转写：请点击地址栏锁形图标允许麦克风，或先在本页打开麦克风入会。')
        return
      }
    }

    const recognition = new ctor()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let latestInterim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const transcript = result[0]?.transcript?.trim()
        if (result.isFinal && transcript) {
          const message: ChatMessage = {
            id: crypto.randomUUID(),
            sender: `${username}(文字转写)`,
            text: transcript,
            createdAt: Date.now(),
          }
          socketRef.current?.emit('chat-message', { roomId, message })
          setTranscribingPreview('')
        } else if (transcript) {
          latestInterim = transcript
        }
      }
      setTranscribingPreview(latestInterim)
    }
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const code = typeof event.error === 'string' ? event.error : 'unknown'
      // Chrome 在静音一段时间后会报 no-speech，不应关闭整段监听
      if (code === 'no-speech' || code === 'aborted') {
        return
      }
      speechKeepAliveRef.current = false
      setSpeechOn(false)
      const tips: Record<string, string> = {
        'not-allowed':
          '文字转写被拒绝：请在站点设置中允许麦克风，或先打开麦克风入会后再试「开启文字转写」。',
        'audio-capture': '未检测到可用麦克风，请检查设备连接。',
        network:
          '文字转写网络异常：Chrome 在大陆常无法连接谷歌语音服务。可改用 Edge、开启系统代理，或使用下方输入框把内容发到会中消息。',
        'service-not-allowed': '当前环境不允许语音服务，请使用 Chrome/Edge，并尽量使用 localhost 或 HTTPS。',
      }
      setRtcTip(tips[code] ?? `文字转写异常（${code}），请重试。`)
    }
    recognition.onend = () => {
      if (speechKeepAliveRef.current) {
        try {
          recognition.start()
        } catch {
          setSpeechOn(false)
          speechKeepAliveRef.current = false
        }
        return
      }
      setSpeechOn(false)
      setTranscribingPreview('')
    }
    try {
      recognition.start()
    } catch {
      speechMicStreamRef.current?.getTracks().forEach((track) => track.stop())
      speechMicStreamRef.current = null
      setRtcTip('文字转写未能启动，请刷新页面后重试。')
      return
    }
    speechRef.current = recognition
    speechKeepAliveRef.current = true
    setSpeechOn(true)
    setActiveSttMode('browser')
    setRtcTip('已使用浏览器转写（大陆网络可能不可用）；推荐配置 STT_API_KEY 使用服务端转写。')
  }

  const sendManualTranscript = () => {
    const text = speechManual.trim()
    if (!text) {
      return
    }
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      sender: `${username}(文字转写)`,
      text,
      createdAt: Date.now(),
    }
    socketRef.current?.emit('chat-message', { roomId, message })
    setSpeechManual('')
    setRtcTip('已发送到「会中消息」，可继续输入或生成纪要。')
  }
 
  const drawOnBoard = (event: MouseEvent<HTMLCanvasElement>) => {//白板绘制的核心函数，绑定在 Canvas 的 mousemove 事件上
    const canvas = canvasRef.current
    if (!canvas || !isDrawingRef.current) {
      return
    } //鼠标相对于浏览器窗口的坐标，项目中封装的工具函数，作用是把鼠标的窗口坐标转换成 Canvas 画布上的真实坐标
    const { x: x1, y: y1 } = whiteboardPointerCoords(canvas, event.clientX, event.clientY)//把鼠标位置映射到 Canvas 画布
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    const prevX = Number(canvas.dataset.prevX ?? x1)
    const prevY = Number(canvas.dataset.prevY ?? y1)
    ctx.strokeStyle = '#61a0ff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(prevX, prevY)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    socketRef.current?.emit('whiteboard-draw', {
      roomId,
      stroke: { x0: prevX, y0: prevY, x1, y1, color: '#61a0ff' },
    })
    canvas.dataset.prevX = String(x1)
    canvas.dataset.prevY = String(y1)
  }

  const clearBoard = () => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    socketRef.current?.emit('whiteboard-clear', { roomId })
  }

  const leaveMeeting = () => {
    persistMeetingRecord(true)
    socketRef.current?.disconnect()
    navigate('/')
  }

  const submitJoinPassword = () => {
    const pwd = joinPasswordInput.trim()
    if (!pwd) {
      setJoinPasswordError('请输入会议密码')
      return
    }
    joinPasswordRef.current = pwd
    try {
      localStorage.setItem(roomPwdKey, pwd)
    } catch {
      /* ignore */
    }
    socketRef.current?.emit('join-room', {
      roomId,
      name: username,
      password: pwd,
      createIfMissing,
      clientKey: clientKeyRef.current,
    })
    setJoinPasswordError('')
    setRtcTip('正在校验会议密码...')
  }

  return (
    <main className={`page meeting-page ${themeMode === 'light' ? 'theme-light' : 'theme-dark'}`}>
      <header className="meeting-header">
        <div>
          <h2>免费版会议</h2>
          <p>
            会议号：{roomId} · {roomMeta.locked ? '已锁定' : '可加入'} · {networkTip}
          </p>
        </div>
        <div className="hero-buttons">
          <button className="ghost-btn" onClick={() => setShowSettings(true)}>设置</button>
          <button className="danger-btn" onClick={leaveMeeting}>
            结束会议
          </button>
        </div>
      </header>

      {permissionTip ? <p className="permission-tip">{permissionTip}</p> : null}
      {joinFailed ? (
        <p className="permission-tip">
          {rtcTip ? <>{rtcTip}</> : null}
          {rtcTip ? <br /> : null}
          入会失败，请返回 <Link to="/join">加入页</Link> 重新输入会议信息。
          {(rtcTip.includes('会议不存在') || rtcTip.includes('尚未有人')) && (
            <>
              <br />
              <button
                type="button"
                className="ghost-btn permission-tip-btn"
                onClick={() => {
                  const pwd = String(joinPasswordRef.current ?? '').trim()
                  navigate(
                    `/meeting?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(username)}&mic=${micOn ? '1' : '0'}&cam=${camOn ? '1' : '0'}&pwd=${encodeURIComponent(pwd)}&create=1`,
                  )
                }}
              >
                无人创建？转为「创建该会议」并进入
              </button>
            </>
          )}
        </p>
      ) : rtcTip ? (
        <p className="permission-tip">{rtcTip}</p>
      ) : null}
      {wasRemoved ? (
        <p className="permission-tip">
          当前已退出会议，请返回 <Link to="/join">加入页</Link> 重新入会。
        </p>
      ) : null}

      {showJoinPasswordModal ? (
        <section className="settings-overlay" onClick={() => setShowJoinPasswordModal(false)}>
          <div className="settings-modal join-password-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h3>输入会议密码</h3>
              <button onClick={() => setShowJoinPasswordModal(false)}>×</button>
            </div>
            <p className="chat-time">会议 {roomId} 已加密，请输入正确密码后加入。</p>
            <input
              className="join-password-input"
              type="password"
              value={joinPasswordInput}
              onChange={(event) => setJoinPasswordInput(event.target.value)}
              placeholder="请输入会议密码"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitJoinPassword()
                }
              }}
            />
            {joinPasswordError ? <p className="device-tip">{joinPasswordError}</p> : null}
            <div className="hero-buttons">
              <button className="ghost-btn" onClick={() => navigate('/join')}>返回加入页</button>
              <button className="primary-btn" onClick={submitJoinPassword}>确认加入</button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="meeting-body">
        <section className={`video-grid ${showSharedLayout ? 'video-grid-shared' : ''}`}>
          {showSharedLayout ? (
            <>
              <article className="video-card shared-card">
                {isSharingScreen ? (
                  <video
                    ref={localVideoRef}
                    className="local-video shared-video"
                    autoPlay
                    muted
                    playsInline
                  />
                ) : sharedRemoteMember ? (
                  <RemoteVideo stream={remoteStreams[sharedRemoteMember.id]} />
                ) : null}
                <footer>
                  {isSharingScreen ? `${username}（共享中）` : `${sharedRemoteMember?.name ?? '成员'}（共享中）`}
                </footer>
              </article>
              <div className="thumbnail-row">
                <article className="video-card">
                  {!isSharingScreen ? (
                    <video
                      ref={localVideoRef}
                      className={`local-video ${camOn ? '' : 'is-video-off'} ${virtualBgSimpleBlur ? 'vb-simple-blur' : ''}`}
                      autoPlay
                      muted
                      playsInline
                    />
                  ) : null}
                  {!camOn || isSharingScreen ? (
                    <div className="video-placeholder">{username.slice(0, 1)}</div>
                  ) : null}
                  <footer>
                    {username}（我）
                    {isHost ? ' · 主持人' : ''}
                    {micOn ? ' · 麦克风开' : ' · 麦克风关'}
                    {speaking ? ' · 正在说话' : ''}
                    {handRaised ? ' · ✋举手' : ''}
                  </footer>
                </article>
                {remoteMembers
                  .filter((member) => !member.isSharingScreen)
                  .map((member) => (
                    <article key={member.id} className="video-card">
                    {remoteStreams[member.id] && (member.camOn || member.isSharingScreen) ? (
                        <RemoteVideo stream={remoteStreams[member.id]} />
                      ) : (
                        <div className="video-placeholder">{member.name.slice(0, 1)}</div>
                      )}
                      <footer>
                        {member.name}
                        {member.isHost ? ' · 主持人' : ''}
                        {member.micOn ? ' · 麦克风开' : ' · 麦克风关'}
                        {member.camOn ? ' · 摄像头开' : ' · 摄像头关'}
                        {member.handRaised ? ' · ✋举手' : ''}
                      </footer>
                    </article>
                  ))}
              </div>
            </>
          ) : (
            <>
              <article className="video-card">
                <video
                  ref={localVideoRef}
                  className={`local-video ${camOn ? '' : 'is-video-off'} ${virtualBgSimpleBlur ? 'vb-simple-blur' : ''}`}
                  autoPlay
                  muted
                  playsInline
                />
                {!camOn ? <div className="video-placeholder">{username.slice(0, 1)}</div> : null}
                <footer>
                  {username}（我）
                  {isHost ? ' · 主持人' : ''}
                  {micOn ? ' · 麦克风开' : ' · 麦克风关'}
                  {speaking ? ' · 正在说话' : ''}
                  {handRaised ? ' · ✋举手' : ''}
                </footer>
              </article>
              {remoteMembers.map((member) => (
                <article key={member.id} className="video-card">
                  {remoteStreams[member.id] && (member.camOn || member.isSharingScreen) ? (
                    <RemoteVideo stream={remoteStreams[member.id]} />
                  ) : (
                    <div className="video-placeholder">{member.name.slice(0, 1)}</div>
                  )}
                  <footer>
                    {member.name}
                    {member.isHost ? ' · 主持人' : ''}
                    {member.micOn ? ' · 麦克风开' : ' · 麦克风关'}
                    {member.camOn ? ' · 摄像头开' : ' · 摄像头关'}
                    {member.handRaised ? ' · ✋举手' : ''}
                  </footer>
                </article>
              ))}
            </>
          )}
        </section>

        <aside className="meeting-sidebar">
          <h3>参会成员（{remoteMembers.length + 1}）</h3>
          {isHost && raisedMembers.length > 0 ? (
            <div className="raised-panel">
              <div className="raised-title">✋ 举手中</div>
              <div className="raised-list">
                {raisedMembers.map((m) => (
                  <span key={m.id} className="raised-chip">
                    {m.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <ul>
            <li key={localMember.id}>
              {localMember.name}（我）
              {isHost ? ' · 主持人' : ''}
              {handRaised ? ' · ✋举手' : ''}
            </li>
            {remoteMembers.map((member) => (
              <li key={member.id}>
                {member.name}
                {member.isHost ? '（主持人）' : ''}
                {member.handRaised ? ' · ✋举手' : ''}
                <button
                  type="button"
                  className="inline-action-btn"
                  onClick={() => setPrivateChatTargetId(member.id)}
                >
                  私聊
                </button>
                {isHost && !member.isHost ? (
                  <span>
                    <button
                      className="inline-action-btn"
                      onClick={() => removeMember(member.id)}
                    >
                      移除
                    </button>
                    <button
                      className="inline-action-btn"
                      onClick={() => transferHost(member.id)}
                    >
                      转主持
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {isHost ? (
            <div className="host-tools">
              <button className="host-action-btn" onClick={muteAll}>
                主持人：全员静音
              </button>
              <button className="host-action-btn" onClick={toggleLock}>
                {roomMeta.locked ? '解除锁定会议' : '锁定会议'}
              </button>
              <input
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                placeholder={roomMeta.hasPassword ? '更新会议密码' : '设置会议密码'}
              />
              <button className="host-action-btn" onClick={updateRoomPassword}>
                保存会议密码
              </button>
            </div>
          ) : null}

          <section className="agent-mvp-section">
            <h3>智能体 MVP</h3>
            <div className="chat-panel">
              {agentAnswer ? (
                <>
                  {agentPlan.length > 0 ? (
                    <div className="chat-time">
                      计划：{agentPlan.map((p, idx) => `${idx + 1}.${p}`).join('  ')}
                    </div>
                  ) : null}
                  <pre className="summary-text">{agentAnswer}</pre>
                  {agentSteps.length > 0 ? (
                    <div className="chat-time">
                      工具执行：
                      {agentSteps.map((step, idx) => (
                        <div key={`${step.tool}-${idx}`}>
                          {idx + 1}. {step.tool}（{step.reason}）
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {agentReview ? (
                    <div className="chat-time">
                      复盘：
                      <div>{agentReview}</div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p>输入目标后自动规划步骤并输出结论（答辩/会议纪要场景）。</p>
              )}
            </div>
            <div className="chat-input-row">
              <input
                value={agentGoal}
                onChange={(event) => setAgentGoal(event.target.value)}
                placeholder="例如：根据会中消息生成答辩行动计划"
              />
              <button onClick={() => void runAgentMvp()} disabled={agentLoading}>
                {agentLoading ? '执行中...' : '运行智能体'}
              </button>
            </div>
          </section>

          <h3>会中消息</h3>
          {privateChatTargetId ? (
            <p className="chat-private-hint">
              当前发送至：
              <strong>
                {remoteMembers.find((m) => m.id === privateChatTargetId)?.name ?? '成员'}
              </strong>
              （仅对方可见）
              <button type="button" className="inline-action-btn" onClick={() => setPrivateChatTargetId('')}>
                切回公聊
              </button>
            </p>
          ) : null}
          <div className="chat-panel">
            {messages.length === 0 && !(speechOn && transcribingPreview.trim()) ? (
              <p className="chat-empty">
                暂无消息。配置 STT_API_KEY 后开启「文字转写」可由服务端自动写入；也可在下方手动输入发送。
              </p>
            ) : null}
            {messages.map((message) => {
              const isTranscript = message.sender.includes('文字转写')
              const selfId = localMemberId
              const isPrivateBubble = Boolean(message.isPrivate && message.fromId && message.toId)
              let headLabel = message.sender
              if (isPrivateBubble) {
                if (message.fromId === selfId) {
                  headLabel = `${message.sender} → ${message.toName ?? '对方'}（私聊）`
                } else {
                  headLabel = `${message.sender} → 我（私聊）`
                }
              }
              return (
                <div
                  key={message.id}
                  className={['chat-bubble', isTranscript ? 'chat-bubble-transcript' : '', isPrivateBubble ? 'chat-bubble-private' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className="chat-bubble-head">{headLabel}</div>
                  <div className="chat-bubble-body">{message.text}</div>
                  <div className="chat-bubble-time">{formatTime(message.createdAt)}</div>
                </div>
              )
            })}
            {speechOn && transcribingPreview.trim() ? (
              <div className="chat-bubble chat-bubble-transcript chat-bubble-pending">
                <div className="chat-bubble-head">{username}(文字转写) · 识别中</div>
                <div className="chat-bubble-body">{transcribingPreview}</div>
              </div>
            ) : null}
          </div>
          <div className="chat-target-row">
            <label className="chat-target-label">
              发送至
              <select
                value={privateChatTargetId}
                onChange={(event) => setPrivateChatTargetId(event.target.value)}
              >
                <option value="">所有人（公聊）</option>
                {remoteMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（私聊）
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="chat-input-row">
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder={privateChatTargetId ? '输入私聊内容' : '输入会中消息'}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  sendChatMessage()
                }
              }}
            />
            <button onClick={sendChatMessage}>发送</button>
            <button onClick={exportChat}>导出</button>
          </div>

          <h3>AI 助手</h3>
          <div className="chat-panel">
            {aiAnswer ? <p>{aiAnswer}</p> : <p>输入问题后，AI 会结合会中聊天记录给出答复。</p>}
          </div>
          {speechOn ? (
            <p className="speech-status">
              {activeSttMode === 'server'
                ? '服务端转写已开：约每 3 秒一段音频识别后自动写入「会中消息」'
                : '浏览器转写已开：每句结束自动写入「会中消息」'}
              {transcribingPreview.trim() ? ` · ${transcribingPreview}` : ''}
            </p>
          ) : null}
          <div className="speech-fallback-row">
            <input
              value={speechManual}
              onChange={(event) => setSpeechManual(event.target.value)}
              placeholder="浏览器转写失败时：在此输入内容，回车或按钮发到会中消息"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  sendManualTranscript()
                }
              }}
            />
            <button type="button" onClick={sendManualTranscript}>
              发送到消息
            </button>
          </div>
          <div className="chat-input-row">
            <input
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder="例如：总结老师刚才提出的三点意见"
            />
            <button onClick={() => void askAi()} disabled={aiLoading}>
              {aiLoading ? '思考中...' : '提问 AI'}
            </button>
          </div>

          <h3>会后纪要</h3>
          <div className="chat-panel">
            {aiSummary ? <pre className="summary-text">{aiSummary}</pre> : <p>点击“生成纪要”后，AI 会输出结构化会后总结。</p>}
          </div>
          <div className="chat-input-row">
            <button onClick={() => void createSummary()} disabled={summaryLoading}>
              {summaryLoading ? '生成中...' : '生成纪要'}
            </button>
            <button onClick={exportSummary}>导出纪要</button>
          </div>
          <h3>录制回放</h3>
          <div className="chat-panel">
            {recordedVideoUrl ? (
              <>
                <video 
                  ref={recordPlayerRef}
                  className="record-player"
                  src={recordedVideoUrl}
                  controls
                  onLoadedMetadata={(event) => setRecordDurationSec(event.currentTarget.duration || 0)}
                  onTimeUpdate={(event) => setRecordCurrentSec(event.currentTarget.currentTime || 0)}
                />
                <div className="record-controls">
                  <label>
                    播放速度
                    <select
                      value={recordPlaybackRate}
                      onChange={(event) => {
                        const rate = Number(event.target.value)
                        setRecordPlaybackRate(rate)
                        if (recordPlayerRef.current) {
                          recordPlayerRef.current.playbackRate = rate
                        }
                      }}
                    >
                      <option value={0.5}>0.5x</option>
                      <option value={0.75}>0.75x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.25}>1.25x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>
                  </label>
                  <p className="chat-time">
                    播放时间：{formatDuration(recordCurrentSec)} / {formatDuration(recordDurationSec)}
                  </p>
                </div>
                <p className="chat-time">文件：{recordedVideoName}</p>
              </>
            ) : (
              <p className="chat-empty">录制结束后会在这里出现播放器，支持直接回放。</p>
            )}
          </div>
        </aside>
      </section>

      {showWhiteboard ? (
        <section className="whiteboard-panel" ref={whiteboardPanelRef}>
          <div className="whiteboard-tools">
            <button onClick={clearBoard}>清空白板</button>
            <button onClick={() => setShowWhiteboard(false)}>关闭白板</button>
          </div>
          <canvas
            ref={canvasRef}
            className="whiteboard-canvas"
            onMouseDown={(event) => {
              isDrawingRef.current = true
              const { x, y } = whiteboardPointerCoords(
                event.currentTarget,
                event.clientX,
                event.clientY,
              )
              event.currentTarget.dataset.prevX = String(x)
              event.currentTarget.dataset.prevY = String(y)
            }}
            onMouseMove={drawOnBoard}
            onMouseUp={() => {
              isDrawingRef.current = false
            }}
            onMouseLeave={() => {
              isDrawingRef.current = false
            }}
          />
        </section>
      ) : null}

      {showSettings ? (
        <section className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h3>设置</h3>
              <button onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="settings-grid">
              <label>
                主题模式
                <select
                  value={themeMode}
                  onChange={(event) => setThemeMode(event.target.value as 'dark' | 'light')}
                >
                  <option value="dark">黑色模式</option>
                  <option value="light">白色模式</option>
                </select>
              </label>
              <label>
                虚拟背景
                <select
                  value={virtualBgMode}
                  onChange={(event) => {
                    const mode = event.target.value as 'off' | 'blur' | 'image'
                    setVirtualBgMode(mode)
                    if (mode === 'off') {
                      stopVirtualBackground()
                      const localStream = streamRef.current
                      const cameraTrack = localStream?.getVideoTracks()[0]
                      if (cameraTrack && !isSharingScreen) {
                        replaceOutgoingVideoTrack(cameraTrack)
                        renegotiateAllPeers()
                        if (localVideoRef.current) {
                          localVideoRef.current.srcObject = localStream
                        }
                      }
                      setRtcTip('虚拟背景已关闭')
                      return
                    }
                    void startVirtualBackground().then(() => {
                      setRtcTip(mode === 'blur' ? '虚拟背景：已开启背景模糊' : '虚拟背景：已开启背景替换')
                    })
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="blur">背景模糊（人像清晰）</option>
                  <option value="image">更换背景图</option>
                </select>
              </label>
              <p className="chat-time">
                虚拟背景状态：{virtualBgStatus === 'off'
                  ? '未启用'
                  : virtualBgStatus === 'starting'
                    ? '启动中…'
                    : virtualBgStatus === 'running'
                      ? '运行中（应看到 VB）'
                      : '失败'}
                {virtualBgError ? ` · ${virtualBgError}` : ''}
              </p>
              {virtualBgStatus === 'running' ? (
                <div className="virtual-preview-wrap">
                  <p className="chat-time">虚拟背景预览（应看到 VB）：</p>
                  <canvas ref={virtualPreviewRef} className="virtual-preview" />
                </div>
              ) : null}
              {virtualBgMode === 'image' ? (
                <label>
                  背景图片
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (!file) {
                        return
                      }
                      const reader = new FileReader()
                      reader.onload = () => {
                        const url = String(reader.result ?? '')
                        setVirtualBgImage(url)
                        virtualBgImageElRef.current = null
                        void startVirtualBackground()
                      }
                      reader.readAsDataURL(file)
                    }}
                  />
                  <p className="chat-time">建议选择 16:9 图片，效果更自然。</p>
                </label>
              ) : null}
              <label>
                录屏保存位置
                <select
                  value={recordSaveMode}
                  onChange={(event) =>
                    setRecordSaveMode(event.target.value as 'download' | 'pick')
                  }
                >
                  <option value="download">默认下载目录</option>
                  <option value="pick">每次录制后手动选择位置</option>
                </select>
              </label>
              <p className="chat-time">当前保存策略：{recordSaveHint}</p>
              <p className="chat-time">
                下载目录说明：网页无法直接设置系统固定下载路径；如需指定目录，请选择“每次录制后手动选择位置”。
              </p>
              <label>
                麦克风设备
                <select
                  value={selectedAudio}
                  onChange={(event) => setSelectedAudio(event.target.value)}
                >
                  {audioDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || '默认麦克风'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                摄像头设备
                <select
                  value={selectedVideo}
                  onChange={(event) => setSelectedVideo(event.target.value)}
                >
                  {videoDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || '默认摄像头'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                清晰度
                <select
                  value={quality}
                  onChange={(event) =>
                    setQuality(event.target.value as 'low' | 'medium' | 'high')
                  }
                >
                  <option value="low">低清 360p</option>
                  <option value="medium">高清 540p</option>
                  <option value="high">超清 720p</option>
                </select>
              </label>
              <div className="hero-buttons">
                <button onClick={applyDeviceSettings}>应用设置</button>
                <button onClick={() => setShowSettings(false)}>关闭设置</button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <video ref={virtualVideoRef} className="virtual-hidden" playsInline muted />
      <canvas ref={virtualCanvasRef} className="virtual-hidden" />

      <footer className="meeting-controls">
        <button onClick={() => setMicOn((prev) => !prev)}>
          {micOn ? '关闭麦克风' : '开启麦克风'}
        </button>
        <button onClick={() => setCamOn((prev) => !prev)}>
          {camOn ? '关闭摄像头' : '开启摄像头'}
        </button>
        <button onClick={() => (isSharingScreen ? stopScreenShare() : void startScreenShare())}>
          {isSharingScreen ? '停止共享' : '共享屏幕'}
        </button>
        <button onClick={() => setShowWhiteboard((prev) => !prev)}>
          {showWhiteboard ? '关闭白板' : '共享白板'}
        </button>
        <button onClick={() => setShowSettings((prev) => !prev)}>
          {showSettings ? '关闭设置' : '设备设置'}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = !handRaised
            setHandRaised(next)
            const socket = socketRef.current
            if (socket) {
              let acked = false
              try {
                socket.emit('hand-raise', { roomId, handRaised: next }, (res: { ok?: boolean }) => {
                  acked = Boolean(res?.ok)
                })
              } catch {
                /* ignore */
              }
              // 兼容旧信令：即使 hand-raise 没实现，也用 member-update 同步一次
              socket.emit('member-update', {
                roomId,
                micOn,
                camOn,
                isSharingScreen,
                handRaised: next,
              })
              window.setTimeout(() => {
                if (!acked) {
                  setRtcTip('举手未收到信令回执：请确认已重启 npm run signal（否则其它成员可能看不到）。')
                }
              }, 1200)
            }
            setRtcTip(next ? '已举手，主持人会看到你的举手状态。' : '已放下举手。')
          }}
        >
          {handRaised ? '放下举手' : '举手'}
        </button>
        <button
          type="button"
          onClick={() => void toggleSpeech()}
          title={
            serverSttAvailable
              ? '服务端转写（推荐，需已配置 STT_API_KEY）'
              : speechSupported
                ? '浏览器转写（大陆网络可能不可用）'
                : '优先尝试服务端；请确认信令已启动并配置 STT_API_KEY'
          }
        >
          {speechOn ? '关闭文字转写' : '开启文字转写'}
        </button>
        <button onClick={copyInviteLink}>复制邀请</button>
        <button onClick={() => (recording ? stopRecording() : void startRecording())}>
          {recording ? '停止录制' : '开始录制'}
        </button>
      </footer>
    </main>
  )
}

export default MeetingPage
