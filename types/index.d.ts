export type Usage = {
  contextPercent: number | null
  weekPercent: number | null
  weekResetsAt: string | null
}

export type CiRun = { status: string; conclusion: string; workflow: string }

export type GitInfo = { branch: string | null; ci: CiRun | null }

export type TestRun = {
  passed: number
  failed: number
  skipped: number
  total: number
  seconds: number
  exitCode: number
  hasSummary: boolean
  logPath: string
}

declare module 'claude-code' {
  interface PluginState {
    'socio-tecnico': { usage: Usage | null; git: GitInfo | null; lastTest: TestRun | null; isMuted: boolean }
  }
}
