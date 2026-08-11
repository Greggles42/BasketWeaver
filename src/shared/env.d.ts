// Compile-time flag injected by electron.vite.config.ts based on build mode.
// true for `electron-vite dev` and any `--mode development` build; false (and
// dead-code-eliminated) for the default production build used by `dist`.
declare const __DEV__: boolean
