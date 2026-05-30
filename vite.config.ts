import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

/** 开发/预览：将信令与 HTTP API 代理到本机 Node（与前端同源） */
function signalProxy(signalPort: string) {
  const target = `http://127.0.0.1:${signalPort}`
  return {
    '/socket.io': {
      target,
      ws: true,
      changeOrigin: true,
      secure: false,
    },
    '/api': {
      target,
      changeOrigin: true,
      secure: false,
    },
  } as const
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const signalPort = env.PORT?.trim() || '3001'

  return {
    plugins: [
      react(),
      basicSsl(),
      {
        name: 'mediapipe-script-first',
        transformIndexHtml(html) {
          const mp =
            '<script src="/mediapipe/selfie_segmentation/selfie_segmentation.js" data-mp-selfie-seg="1"></script>'
          const probe =
            '<script>window.__MP_SELFIE_OK__=typeof globalThis.SelfieSegmentation==="function"</script>'
          const stripped = html
            .replace(/\s*<script src="\/mediapipe\/selfie_segmentation\/selfie_segmentation\.js"[^>]*><\/script>\s*/g, '\n')
            .replace(/\s*<script>window\.__MP_SELFIE_OK__[^<]*<\/script>\s*/g, '\n')
          return stripped.replace(
            /(<script type="module"[^>]*><\/script>)/,
            `${mp}\n    ${probe}\n    $1`,
          )
        },
      },
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: signalProxy(signalPort),
    },
    preview: {
      port: 5173,
      strictPort: true,
      proxy: signalProxy(signalPort),
    },
    build: {
      sourcemap: false,
    },
  }
})
