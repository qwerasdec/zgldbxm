export type MemberState = {
  id: string
  name: string
  micOn: boolean
  camOn: boolean
  isHost: boolean
  isSharingScreen?: boolean
  handRaised?: boolean
}

export type ChatMessage = {
  id: string
  sender: string
  text: string
  createdAt: number
  /** 仅收发双方可见的私聊 */
  isPrivate?: boolean
  /** 发送方 socket id（与成员 id 一致） */
  fromId?: string
  /** 接收方 socket id */
  toId?: string
  /** 接收方显示名（用于气泡标题） */
  toName?: string
}

export type RoomMeta = {
  locked: boolean
  hasPassword: boolean
  hostId: string
  createdAt: number
}

export type MeetingRecord = {
  id?: number
  roomId: string
  username: string
  joinedAt: number
  leftAt: number
  durationSec: number
  messageCount: number
  participantCount: number
}

export type ScheduledMeeting = {
  id: string
  topic: string
  roomId: string
  hostName: string
  startAt: number
  password?: string
  createdAt: number
}

export type RoomMessage =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
