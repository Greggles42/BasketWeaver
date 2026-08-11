import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const isDev = mode !== 'production'
  const define = {
    __LEADERBOARD_WORKER_URL__: JSON.stringify(env.LEADERBOARD_WORKER_URL ?? ''),
    __LEADERBOARD_API_KEY__:    JSON.stringify(env.LEADERBOARD_API_KEY    ?? ''),
    __DEV__: JSON.stringify(isDev),
  }
  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: {
      rollupOptions: {
        input: {
          index:       resolve(__dirname, 'src/main/preload.ts'),
          settings:    resolve(__dirname, 'src/main/preload-settings.ts'),
          leaderboard: resolve(__dirname, 'src/main/preload-leaderboard.ts'),
        }
      }
    }
  },
  renderer: {
    define,
    build: {
      rollupOptions: {
        input: {
          index:       resolve(__dirname, 'src/renderer/index.html'),
          settings:    resolve(__dirname, 'src/renderer/settings.html'),
          leaderboard: resolve(__dirname, 'src/renderer/leaderboard.html'),
        }
      }
    }
  }
  }
})
