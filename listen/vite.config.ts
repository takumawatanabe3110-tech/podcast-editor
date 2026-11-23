import { defineConfig } from 'vite'

// 試聴ページ（スマホ用）。どこに置いても動くように相対パスで書き出す（GitHub Pages のサブフォルダなど）
export default defineConfig({
  base: './',
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
})
