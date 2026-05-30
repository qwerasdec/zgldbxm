import { useEffect, useRef } from 'react'

type RemoteVideoProps = {
  stream: MediaStream
}

function RemoteVideo({ stream }: RemoteVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) {
      return
    }
    el.srcObject = stream
    el.muted = true
    const play = () => {
      void el.play().catch(() => {
        /* 部分手机需用户交互后才 play，ontrack 时再试一次 */
      })
    }
    play()
    stream.getTracks().forEach((track) => {
      track.addEventListener('unmute', play)
    })
    return () => {
      stream.getTracks().forEach((track) => {
        track.removeEventListener('unmute', play)
      })
      if (el.srcObject === stream) {
        el.srcObject = null
      }
    }
  }, [stream])

  return <video ref={videoRef} className="local-video" autoPlay playsInline muted />
}

export default RemoteVideo
