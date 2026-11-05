import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// доступ к действиям для тестового режима (VA_SHOT)
import * as actions from './lib/actions'
import { get, set } from './lib/store'
Object.assign(window, { __va: { ...actions, get, set } })
