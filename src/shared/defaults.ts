import type { AppConfig, AppSettings, RdpOptions, SessionInput } from './types'

export const SCHEMA_VERSION = 1

export function defaultRdpOptions(): RdpOptions {
  return {
    width: 1920,
    height: 1080,
    fullscreen: false,
    clipboard: true,
    audio: 'local',
    colorDepth: 32,
    domain: '',
    adminSession: false
  }
}

export function defaultSettings(): AppSettings {
  return {
    theme: 'dark',
    fontSize: 14,
    fontFamily:
      "'JetBrains Mono', 'Cascadia Mono', Consolas, 'Microsoft YaHei Mono', 'Noto Sans Mono', monospace",
    cursorBlink: true,
    confirmOnClose: true,
    allowPlaintextCredential: false
  }
}

export function emptySessionInput(): SessionInput {
  return {
    name: '',
    groupId: null,
    protocol: 'ssh',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    privateKeyPath: '',
    tunnelSessionId: null,
    rdp: defaultRdpOptions(),
    note: ''
  }
}

export function emptyConfig(): AppConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    groups: [],
    sessions: [],
    forwards: [],
    settings: defaultSettings(),
    k8sClusters: []
  }
}
