import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LoopDashboard } from './components/LoopDashboard/index'
import './assets/index.css'

// Determine rendering mode from URL query string.
// ?mode=loop  → Loop Dashboard window
// ?mode=fullscreen → handled internally by App (fullscreen grid terminal)
// (default)   → main App
const params = new URLSearchParams(window.location.search)
const mode = params.get('mode')

let root: React.ReactElement

if (mode === 'loop') {
    root = <LoopDashboard />
} else {
    // Default: main App (also handles ?mode=fullscreen internally)
    root = <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        {root}
    </React.StrictMode>
)
