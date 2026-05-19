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
})
