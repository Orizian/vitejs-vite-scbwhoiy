import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Two entry points: the game at / and the mission editor at /editor.html.
// They share the mission format module and nothing else.
//
// Tailwind is compiled here rather than pulled from a CDN, so the UI renders
// identically offline, in CI and in headless browser tests.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        editor: resolve(import.meta.dirname, 'editor.html'),
      },
    },
  },
})
