import { z } from 'zod'

export const calendarCaptureSchema = z.object({
  x: z.number().int().min(0).max(16384),
  y: z.number().int().min(0).max(16384),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
}).strict().refine((rect) => rect.width * rect.height <= 16_777_216)
export type CalendarCaptureRect = z.infer<typeof calendarCaptureSchema>
