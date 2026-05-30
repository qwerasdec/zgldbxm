import {
  DEFAULT_USERS,
  MEETING_RECORDS_KEY,
  SCHEDULED_MEETINGS_KEY,
  USERS_KEY,
} from '../constants/meeting'
import type { MeetingRecord, ScheduledMeeting } from '../types/meeting'
import { SIGNAL_SERVER_URL } from '../constants/meeting'

type DefaultUsers = typeof DEFAULT_USERS

export function ensureUsers(): DefaultUsers {
  const raw = localStorage.getItem(USERS_KEY)
  if (!raw) {
    localStorage.setItem(USERS_KEY, JSON.stringify(DEFAULT_USERS))
    return DEFAULT_USERS
  }
  try {
    return JSON.parse(raw) as DefaultUsers
  } catch {
    localStorage.setItem(USERS_KEY, JSON.stringify(DEFAULT_USERS))
    return DEFAULT_USERS
  }
}

export function getMeetingRecords(limit?: number): MeetingRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEETING_RECORDS_KEY) ?? '[]') as MeetingRecord[]
    return typeof limit === 'number' ? parsed.slice(0, limit) : parsed
  } catch {
    return []
  }
}

export function saveMeetingRecord(record: MeetingRecord): void {
  const existing = getMeetingRecords()
  localStorage.setItem(MEETING_RECORDS_KEY, JSON.stringify([record, ...existing].slice(0, 30)))
}

export function deleteMeetingRecordLocal(record: MeetingRecord): void {
  const existing = getMeetingRecords()
  // 优先用 id 删除；否则用 roomId+leftAt 兜底（历史本地数据可能没带 id）
  const filtered = existing.filter((r) => {
    if (typeof r.id === 'number' && typeof record.id === 'number') {
      return r.id !== record.id
    }
    return !(r.roomId === record.roomId && r.leftAt === record.leftAt && r.username === record.username)
  })
  localStorage.setItem(MEETING_RECORDS_KEY, JSON.stringify(filtered))
}

export function getScheduledMeetings(): ScheduledMeeting[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCHEDULED_MEETINGS_KEY) ?? '[]') as ScheduledMeeting[]
    return parsed.sort((a, b) => a.startAt - b.startAt)
  } catch {
    return []
  }
}

export function saveScheduledMeeting(meeting: ScheduledMeeting): void {
  const existing = getScheduledMeetings()
  const merged = [meeting, ...existing.filter((item) => item.id !== meeting.id)]
  localStorage.setItem(SCHEDULED_MEETINGS_KEY, JSON.stringify(merged.slice(0, 50)))
}

export function deleteScheduledMeetingLocal(id: string): void {
  const existing = getScheduledMeetings()
  const filtered = existing.filter((m) => m.id !== id)
  localStorage.setItem(SCHEDULED_MEETINGS_KEY, JSON.stringify(filtered))
}

export async function getMeetingRecordsRemote(limit?: number): Promise<MeetingRecord[]> {
  try {
    const response = await fetch(`${SIGNAL_SERVER_URL}/api/data/records`)
    const data = (await response.json()) as { records?: MeetingRecord[] }
    const rows = Array.isArray(data.records) ? data.records : []
    localStorage.setItem(MEETING_RECORDS_KEY, JSON.stringify(rows))
    return typeof limit === 'number' ? rows.slice(0, limit) : rows
  } catch {
    return getMeetingRecords(limit)
  }
}

export async function saveMeetingRecordRemote(record: MeetingRecord): Promise<void> {
  saveMeetingRecord(record)
  try {
    await fetch(`${SIGNAL_SERVER_URL}/api/data/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
  } catch {
    /* fallback already persisted local */
  }
}

export async function getScheduledMeetingsRemote(): Promise<ScheduledMeeting[]> {
  try {
    const response = await fetch(`${SIGNAL_SERVER_URL}/api/data/schedules`)
    const data = (await response.json()) as { meetings?: ScheduledMeeting[] }
    const rows = Array.isArray(data.meetings) ? data.meetings : []
    localStorage.setItem(SCHEDULED_MEETINGS_KEY, JSON.stringify(rows))
    return rows
  } catch {
    return getScheduledMeetings()
  }
}

export async function saveScheduledMeetingRemote(meeting: ScheduledMeeting): Promise<void> {
  saveScheduledMeeting(meeting)
  try {
    await fetch(`${SIGNAL_SERVER_URL}/api/data/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meeting),
    })
  } catch {
    /* fallback already persisted local */
  }
}

export async function deleteScheduledMeetingRemote(id: string): Promise<void> {
  deleteScheduledMeetingLocal(id)
  try {
    await fetch(`${SIGNAL_SERVER_URL}/api/data/schedules`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
  } catch {
    /* ignore: local already updated */
  }
}

export async function deleteMeetingRecordRemote(record: MeetingRecord): Promise<void> {
  deleteMeetingRecordLocal(record)
  try {
    const id = record.id
    if (typeof id === 'number') {
      await fetch(`${SIGNAL_SERVER_URL}/api/data/records`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    }
  } catch {
    /* ignore: local already updated */
  }
}
