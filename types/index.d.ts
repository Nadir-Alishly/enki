// The values enki's hooks module keeps in the session's state.

/** The open task this session orchestrates, as `enki dashboard link` reports it. */
export type BandTask = { slug: string; phase: string; url: string }

declare module 'claude-code' {
  interface PluginState {
    enki: { bandTask: BandTask | null }
  }
}
