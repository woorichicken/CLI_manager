import React from 'react'
import ReactDOM from 'react-dom/client'
import '../assets/index.css'
import './phone.css'
import { PhoneApp } from './PhoneApp'
import { registerWorker } from './push'
import { installViewportFix } from './viewport'

// The phone page (Settings › Phone): served by the Mac's phone server, never loaded in Electron.
installViewportFix()
void registerWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <PhoneApp />
    </React.StrictMode>
)
