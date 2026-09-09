import { useEffect, useState } from 'react'
import type { VoiceConnection } from '../../shared/voice'

export function VoiceConnectionSettings() {
  const [connection, setConnection] = useState<VoiceConnection>({ enabled: false, connections: [] })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    void window.voiceApi.getConnection().then((value) => { if (active) setConnection(value) }).catch(() => { if (active) setMessage('연결 상태를 읽을 수 없습니다. PC 앱을 다시 실행해 주세요.') })
    return () => { active = false }
  }, [])
  const toggle = async () => {
    setBusy(true)
    setMessage('')
    try { setConnection(await window.voiceApi.setEnabled(!connection.enabled)) }
    catch { setMessage('연결을 변경하지 못했습니다. PC 네트워크 상태를 확인해 주세요.') }
    finally { setBusy(false) }
  }
  return <section className="settings-section">
    <p className="settings-label">안드로이드 음성 도우미</p>
    <p className="settings-hint">같은 와이파이에서 음성으로 일정을 조회하고 PC 캘린더를 조작합니다. PC 앱이 실행되어 있어야 합니다.</p>
    <p className="settings-hint">답변은 이 PC의 AI 합성 음성으로 읽습니다. 음성 생성은 PC 안에서 처리합니다.</p>
    <button type="button" className="ghost-button" disabled={busy} onClick={() => { void toggle() }}>
      {busy ? '변경 중…' : connection.enabled ? '휴대폰 연결 끄기' : '휴대폰 연결 켜기'}
    </button>
    {connection.enabled && <>
      <p className="settings-hint">휴대폰 앱을 실행하면 같은 네트워크에서 이 PC를 자동으로 찾습니다. 비밀키 입력은 필요하지 않습니다.</p>
      {!connection.connections.length && <p role="status">와이파이 또는 사설 유선 네트워크에 연결해 주세요.</p>}
      {connection.connections.map((item) => <p key={item.address} className="settings-hint">PC 주소: {item.address}</p>)}
      <p className="settings-hint">같은 네트워크의 앱에서 일정 조회·변경을 사용할 수 있습니다. Windows 방화벽에서 이 PC 앱의 사설 네트워크 연결이 허용되어야 합니다.</p>
    </>}
    {message && <p className="settings-hint" role="status">{message}</p>}
  </section>
}
