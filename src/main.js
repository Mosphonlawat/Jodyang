import '@fontsource-variable/noto-sans-thai';
import './styles.css';
import { mountApp } from './app.js';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

mountApp(document.querySelector('#app'));
