import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // esbuild's CSS minifier collapses `backdrop-filter` + `-webkit-backdrop-filter`
    // into one and keeps only `-webkit-` — which Chromium (Vivaldi/Chrome/Opera)
    // IGNORES (verified: computed backdrop-filter → `none`), so the frosted glass
    // rendered only in Safari on the built site. Use Lightning CSS for
    // minification instead; its browserslist-aware prefixing keeps both.
    cssMinify: 'lightningcss',
  },
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      targets: { chrome: (87 << 16), safari: (14 << 16), firefox: (103 << 16) },
    },
  },
})
