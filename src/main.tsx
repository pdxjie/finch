import { createRoot } from 'react-dom/client';
import App from './App';
import { installFinchApi } from './lib/tauriApi';
import './styles.css';

installFinchApi();
createRoot(document.getElementById('root')!).render(<App />);
