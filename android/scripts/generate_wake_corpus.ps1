param([Parameter(Mandatory = $true)][string]$OutputDirectory, [string]$Voice = 'Microsoft Heami Desktop')
Add-Type -AssemblyName System.Speech
$corpusPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $corpusPath | Out-Null
$groups = @{
  'dev-positive' = @('까치야 내일 야간 누구야', '오늘 뭐 먹지 까치야 내일 야간 누구야', '아까 이야기하던 건 나중에 하고 까치야 오늘 일정 알려줘', '그렇구나 까치야 다음 달 보여줘', '아 맞다 까치야 오늘 주간 누구야', '잠깐만 까치야 이번 주 휴가자 알려줘', '그건 다음에 하자 까치야 내일 일정 알려줘', '점심 먹고 나서 까치야 오늘 교육 있어', '음 알겠어 까치야 근무표 보여줘', '나 먼저 갈게 까치야 내일 근무 누구야', '까치야 오늘 반복업무 알려줘', '그래 수고했어 까치야 오늘 일정 알려줘')
  'dev-negative' = @('오늘 이야기한 것은 어디까지야 내일 다시 이야기하자', '우리 내일 같이 갈까', '오늘 날씨 좋다', '내일 야간 누구야', '아까 이야기한 것 기억하지', '그건 어디까지 했어', '까치가 나무에 앉아 있다', '그건 무슨 가치야', '사치야 그렇게 많이 사지 마', '정치 이야기는 다음에 하자', '내일 일정은 나중에 알려줘', '여기까지야 이제 그만하자')
  'holdout-positive' = @('자료 정리는 끝났고 까치야 다음 교육 언제야', '좋은 생각인데 까치야 오늘 야간 누구야', '그러니까 말이야 까치야 이번 주 일정 알려줘', '이거 먼저 보고 까치야 내일 주간 누구야', '커피 한잔 마시고 까치야 근무표 보여줘', '오늘 회의는 여기서 마치고 까치야 다음 달 보여줘', '전화는 끊었어 까치야 내일 야간 몇 명이야', '밖에 비가 오네 까치야 오늘 일정 알려줘', '할 일이 많구나 까치야 내일 교육 있어', '까치야 이번 주 휴가자 누구야', '그 다음은 까치야 오늘 주간 몇 명이야', '일단 확인했어 까치야 내일 근무표 보여줘')
  'holdout-negative' = @('오늘은 몇 시까지야', '아까 지하철에서 만났어', '같이 이야기하면서 걸어가자', '이야기가 어디까지 갔지', '까치 이야기 좀 들려줘', '마취약은 병원에서 사용하는 거야', '그 말의 가치를 알아야 해', '그건 착각이야 다시 확인해', '정치야 잘 모르겠어', '밤 근무할 사람은 누구니', '새가 깍깍 울고 있어', '오늘 일은 다 마치자')
}
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$manifest = @()
try {
  $speaker.SelectVoice($Voice)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  foreach ($group in ($groups.Keys | Sort-Object)) {
    for ($i=0; $i -lt $groups[$group].Count; $i++) {
      foreach ($rate in @(-2,0,2)) {
        $filename = "$group-$i-rate-$rate.wav"
        $speaker.Rate = $rate
        $speaker.SetOutputToWaveFile((Join-Path $corpusPath $filename), $format)
        $speaker.Speak($groups[$group][$i])
        $speaker.SetOutputToNull()
        $manifest += @{file=$filename; phrase=$groups[$group][$i]; expected=$group.EndsWith('positive'); split=$group.Split('-')[0]; rate=$rate}
      }
    }
  }
} finally { $speaker.Dispose() }
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $corpusPath 'manifest.json') -Encoding utf8
Write-Output "$($manifest.Count) synthetic utterances prepared; dev and holdout phrases fixed before evaluation."
