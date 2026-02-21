import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './renderer/App'
import '@fontsource/noto-sans-kr/latin-400.css'
import '@fontsource/noto-sans-kr/latin-500.css'
import '@fontsource/noto-sans-kr/latin-700.css'
import '@fontsource/noto-sans-kr/korean-400.css'
import '@fontsource/noto-sans-kr/korean-500.css'
import '@fontsource/noto-sans-kr/korean-700.css'
import '@fontsource/noto-sans-jp/japanese-400.css'
import '@fontsource/noto-sans-jp/japanese-500.css'
import '@fontsource/noto-sans-jp/japanese-700.css'
import './renderer/styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
