import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 開発中は Vite（5173）から Python のサーバー（8765）へ /api を中継する。
// 本番は `npm run build` で dist/ を作り、Python のサーバーがそのまま配る。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
})
