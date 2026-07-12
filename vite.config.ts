import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // M6.2 生产单端口：前端构建产物输出到 web/dist，供 server/src/index.ts 的 express.static 托管
    outDir: 'web/dist',
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
