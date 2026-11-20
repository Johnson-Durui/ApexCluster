// Global layers load before any component CSS so that shell, page and component styles win at equal specificity.
import './styles/tokens.css';
import './styles/base.css';
import './styles/compat.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initMotion } from './components/motion';

initMotion();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
