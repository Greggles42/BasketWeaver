/**
 * Preload script for the leaderboard window.
 *
 * Use string literals for IPC channel names to avoid a shared chunk with
 * the overlay preload — shared chunks break Electron's preload sandbox
 * module resolution.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('leaderboardAPI', {
  onData: (cb: (records: unknown[]) => void) =>
    ipcRenderer.on('leaderboard-data', (_e, records: unknown[]) => cb(records)),

  onConfig: (cb: (cfg: { workerUrl: string; characterName: string; uploadEnabled: boolean }) => void) =>
    ipcRenderer.on('leaderboard-config', (_e, cfg) => cb(cfg)),

  uploadRecord: (record: unknown) =>
    ipcRenderer.send('leaderboard-record', record),

  getAll: () => ipcRenderer.invoke('leaderboard-get'),

  openSettings: () => ipcRenderer.send('open-settings'),
})
