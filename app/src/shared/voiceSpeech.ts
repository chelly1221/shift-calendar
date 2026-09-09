/** Natural Korean time labels; display punctuation is kept out of spoken leave badges. */
export function voiceTimeLabel(hour: number, minute = 0): string {
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}시${minute ? ` ${minute}분` : ''}`
}

export function formatVoiceSpeech(text: string): string {
  return text.replace(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g,
    (_match, hour: string, minute: string) => voiceTimeLabel(Number(hour), Number(minute)))
}

export function speakLeaveBadges(entries: [string, Set<string>][]): string {
  return entries.map(([name, badges]) => formatVoiceSpeech(`${name}, ${[...badges].join(', ')}.`)).join('\n')
}
