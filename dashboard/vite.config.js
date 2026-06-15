import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/'))
            return 'react'
          if (id.includes('node_modules/@solana/web3.js/')) return 'solana'
          if (id.includes('node_modules/lucide-react/')) return 'icons'
        },
      },
    },
  },
})
