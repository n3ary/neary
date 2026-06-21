import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Clean, minimal Vite configuration for clean architecture
export default defineConfig({
  plugins: [react()],

  // Expose the package.json version as `__APP_VERSION__` at build time so the
  // Settings panel can show the release marker (e.g. "1.4.1") alongside the
  // build/cache-bust timestamp from the index.html meta tag.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
  },
  
  // Simple build configuration
  build: {
    target: 'es2020',
    minify: 'terser',
    sourcemap: false,
    rollupOptions: {
      // Suppress the benign "dynamically imported but also statically imported"
      // advisory. Several stores/services are intentionally lazy-imported at
      // runtime (inside action functions, e.g. configStore) to break
      // store<->service circular dependencies. Because those modules are also
      // statically imported by components, they already live in the main chunk,
      // so the dynamic import provides no additional code-splitting and Rollup
      // simply notes it. This is an intentional pattern; deeper decoupling so the
      // imports can be made consistent is tracked in issue #25.
      onwarn(warning, defaultHandler) {
        if (
          typeof warning.message === 'string' &&
          warning.message.includes('dynamic import will not move module into another chunk')
        ) {
          return;
        }
        defaultHandler(warning);
      },
      output: {
        // Simple chunk splitting
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) {
              return 'react-vendor';
            }
            if (id.includes('@mui/material') || id.includes('@mui/icons-material')) {
              return 'mui-vendor';
            }
            if (id.includes('zustand') || id.includes('axios')) {
              return 'vendor';
            }
          }
        }
      }
    }
  },
  
  // Development server
  server: {
    port: 5175,
    proxy: {
      // Proxy API requests to avoid CORS
      '/api/tranzy': {
        target: 'https://api.tranzy.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tranzy/, '')
      }
    }
  },
  
  // Optimize dependencies
  optimizeDeps: {
    include: ['react', 'react-dom', 'zustand', 'axios', '@mui/material']
  }
})