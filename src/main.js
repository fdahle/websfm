import { installModalFocus } from './utils/modalFocus.js'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import { colResize } from './utils/resizableColumns.js'
import { registerServiceWorker, watchForStaleCode } from './composables/useAppUpdate.js'
import { onWorkerLoadError } from './workers/computeClient.js'

const disposeModalFocus = installModalFocus()
if (import.meta.hot) import.meta.hot.dispose(disposeModalFocus)

createApp(App).use(createPinia()).directive('col-resize', colResize).mount('#app')

registerServiceWorker().catch((err) => console.warn('Service worker registration failed:', err))
watchForStaleCode({ onWorkerLoadError })
