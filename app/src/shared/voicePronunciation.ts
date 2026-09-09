const nativeHours = ['열두', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한'] as const
const sinoDigits = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'] as const

function spokenMinute(minute: number): string {
  const tens = Math.floor(minute / 10)
  return `${tens > 1 ? sinoDigits[tens] : ''}${tens ? '십' : ''}${sinoDigits[minute % 10]}`
}

function pronounceClockTimes(text: string): string {
  // Preserve links and paths. A clock must not start inside an identifier, date,
  // decimal, or another colon-delimited value such as an ISO timestamp.
  return text.replace(/https?:\/\/\S+|[A-Za-z]:[\\/]\S+|(?<![\p{L}\p{N}_.:/\\])(?:(오전|오후)[ \t]*)?(\d{1,2})(?:[ \t]*:[ \t]*(\d{2})|[ \t]*시(?:[ \t]*(\d{1,2})[ \t]*분)?)(?![\d:]|\.\d)/gu,
    (match: string, period: string | undefined, hourText: string | undefined, colonMinute: string | undefined, minuteText: string | undefined, offset: number) => {
      if (hourText === undefined) return match
      const hour = Number(hourText)
      const minute = Number(colonMinute ?? minuteText ?? 0)
      if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return match

      const following = text.slice(offset + match.length)
      // Allow Korean clock particles while protecting words such as 6시간 and
      // 6시스템, and malformed partial matches such as 6시 300분.
      if (/^[ \t]+\d+[ \t]*분/u.test(following) || (/^[\p{L}\p{N}_]/u.test(following) && !/^(?:부터|까지|쯤|경|에|와|나|로|이며|이고|입니다|였|이었|라서|라고|가|도|는|를|만)/u.test(following))) return match

      let spokenPeriod = period
      if (period && (hour === 0 || hour > 12)) {
        const expectedPeriod = hour === 0 || hour === 24 ? '오전' : '오후'
        if (period !== expectedPeriod) return match
      }
      if (!spokenPeriod && (colonMinute !== undefined || hour === 0 || hour > 12)) {
        spokenPeriod = hour < 12 || hour === 24 ? '오전' : '오후'
      }
      if (spokenPeriod && hour % 12 === 0 && minute === 0) {
        return spokenPeriod === '오전' ? '자정' : '정오'
      }
      const clock = `${nativeHours[hour % 12]} 시${minute ? ` ${spokenMinute(minute)} 분` : ''}`
      return spokenPeriod ? `${spokenPeriod} ${clock}` : clock
    })
}

/** TTS-only pronunciation hints; display text and stored calendar values stay intact. */
export function prepareVoicePronunciation(text: string): string {
  return pronounceClockTimes(text.normalize('NFC')).split(/\r?\n/u).map((line) => {
    let prepared = line.replace(/\s+/gu, ' ').trim()
    if (prepared && !/[.!?;:,'")\]}…。」』】〉》›»]$/u.test(prepared)) prepared += '.'
    return prepared
  }).filter(Boolean).join('\n')
}
