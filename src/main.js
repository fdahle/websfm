import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import 'ol/ol.css'
import 'katex/dist/katex.min.css'
import { colResize } from './utils/resizableColumns.js'

createApp(App)
  .use(createPinia())
  .directive('col-resize', colResize)
  .mount('#app')
