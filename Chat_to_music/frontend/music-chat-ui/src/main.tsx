import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css' //因為tailwind的問題，這段其實沒用到
import App from './App.tsx'
import './App.css';


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
