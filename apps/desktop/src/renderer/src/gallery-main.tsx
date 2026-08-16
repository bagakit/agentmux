import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkflowComponentGallery } from './components/WorkflowComponentGallery'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkflowComponentGallery />
  </StrictMode>
)
