import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  preview: { allowedHosts: ['.trycloudflare.com'] }, // quick-tunnel hostnames; `mise run tunnel`
  plugins: [tanstackStart(), viteReact()],
})

export default config
