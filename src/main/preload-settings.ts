/**
 * Preload for the Settings window — exposes a typed settings API to the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron'

// Use string literals to avoid a shared chunk with the overlay preload,
// which would break the preload sandbox module resolution.
contextBridge.exposeInMainWorld('settingsAPI', {
  getSettings: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('settings-get'),

  setSetting: (key: string, value: unknown): void =>
    ipcRenderer.send('settings-set', { key, value }),

  close: (): void =>
    ipcRenderer.send('close-settings'),

  onCharacterWeaponsLoaded: (cb: (ws: Record<string, unknown>) => void): void => {
    ipcRenderer.on('character-weapons-loaded', (_e, ws) => cb(ws))
  },

  onCharacterDetected: (cb: (name: string) => void): void => {
    ipcRenderer.on('character-detected', (_e, name) => cb(name))
  },

  startWeaveKeyLearn: (): void =>
    ipcRenderer.send('weave-key-learn-start'),

  cancelWeaveKeyLearn: (): void =>
    ipcRenderer.send('weave-key-learn-cancel'),

  onWeaveKeyLearned: (cb: (result: { keycode: number; display: string } | null) => void): void => {
    ipcRenderer.on('weave-key-learned', (_e, result) => cb(result))
  },

  startWeaveKeyLearn2: (): void =>
    ipcRenderer.send('weave-key-learn-start-2'),

  cancelWeaveKeyLearn2: (): void =>
    ipcRenderer.send('weave-key-learn-cancel-2'),

  onWeaveKeyLearned2: (cb: (result: { keycode: number; display: string } | null) => void): void => {
    ipcRenderer.on('weave-key-learned-2', (_e, result) => cb(result))
  },

  getLogCharacters: (): Promise<string[]> =>
    ipcRenderer.invoke('get-log-characters'),

  getZealStatus: (): Promise<{
    pipeConnected: boolean; characterName: string; msSinceLastSwingData: number | null
    eqProcessFound: boolean; lastPipeError: string | null; scanError: string | null
  }> =>
    ipcRenderer.invoke('zeal-status-get'),

  openZealLog: (): Promise<string | null> =>
    ipcRenderer.invoke('zeal-log-open'),
})
