import { z } from 'zod'

export const voiceContextSchema = z.object({
  category: z.enum(['근무', '휴가', '교육', '반복업무', '공휴일', '일정']),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  people: z.array(z.string().min(1).max(40)).max(10),
  team: z.enum(['A', 'B', 'C', 'D']).nullable(),
  shifts: z.array(z.enum(['주간', '야간', '일근'])).max(3),
  answeredAtUtc: z.string().datetime(),
  rosterOnly: z.boolean().optional(),
  clarification: z.object({
    kind: z.enum(['date', 'event', 'person']),
    question: z.string().min(1).max(300),
    eventIds: z.array(z.string().max(500)).max(3).optional(),
    heardName: z.string().min(1).max(40).optional(),
    personCandidates: z.array(z.string().min(1).max(40)).max(100).optional(),
  }).strict().optional(),
}).strict()
export type VoiceContext = z.infer<typeof voiceContextSchema>

export const voiceQuerySchema = z.object({
  text: z.string().trim().min(1).max(300),
  timeZone: z.literal('Asia/Seoul').default('Asia/Seoul'),
  selfName: z.string().trim().max(40).default(''),
  context: voiceContextSchema.nullable().optional(),
}).strict()
export type VoiceQuery = z.infer<typeof voiceQuerySchema>

export const voiceSpeechStateSchema = z.object({
  id: z.string().uuid().nullable(),
  status: z.enum(['idle', 'queued', 'speaking', 'done', 'stopped', 'error']),
  text: z.string(),
  chunk: z.string(),
  error: z.string().optional(),
})
export type VoiceSpeechState = z.infer<typeof voiceSpeechStateSchema>

export const voiceSpeechRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('speak'), text: z.string().trim().min(1).max(200_000) }).strict(),
  z.object({ action: z.literal('stop'), id: z.string().uuid().optional() }).strict(),
])

export const voiceAnswerSchema = z.object({
  status: z.enum(['ANSWER', 'CLARIFY', 'UNSUPPORTED', 'UNAVAILABLE', 'PREVIEW']),
  text: z.string(),
  speech: z.string(),
  source: z.literal('PC에 저장된 일정 기준'),
  answeredAtUtc: z.string().datetime(),
  context: voiceContextSchema.nullable(),
  eventIds: z.array(z.string()),
  confirmationId: z.string().uuid().optional(),
  playback: voiceSpeechStateSchema.optional(),
})
export type VoiceAnswer = z.infer<typeof voiceAnswerSchema>

export const voiceConnectionSchema = z.object({
  enabled: z.boolean(),
  connections: z.array(z.object({ address: z.string() })),
})
export type VoiceConnection = z.infer<typeof voiceConnectionSchema>
export interface VoiceApi {
  getConnection: () => Promise<VoiceConnection>
  setEnabled: (enabled: boolean) => Promise<VoiceConnection>
  onControl: (callback: (control: VoiceControl) => Promise<string>) => () => void
}

export const voiceControlSchema = z.object({
  type: z.enum(['NEXT_MONTH', 'PREVIOUS_MONTH', 'TODAY', 'GOTO_DATE', 'OPEN_ROSTER', 'OPEN_CALENDAR', 'OPEN_SETTINGS', 'OPEN_SYNC', 'REFRESH']),
  date: z.iso.date().optional(),
}).strict()
export type VoiceControl = z.infer<typeof voiceControlSchema>
export const voiceConfirmSchema = z.object({ confirmationId: z.string().uuid(), confirm: z.boolean() }).strict()

export const VOICE_CHANNELS = {
  getConnection: 'voice:get-connection',
  setEnabled: 'voice:set-enabled',
  control: 'voice:control',
  controlResult: 'voice:control-result',
} as const
