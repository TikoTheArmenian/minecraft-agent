/** Checked contracts at the application boundary; Minecraft skill internals remain JavaScript. */
export type Outcome = 'succeeded' | 'partial' | 'blocked' | 'cancelled' | 'failed'
export type Source = 'human' | 'supervisor' | 'peer'
export interface DecisionContext {
  epoch: number
  nav: number
  world: string
  dimension: string | null
  objectiveRevision?: number
}
export interface SkillResult {
  runId: string
  skillId: string
  outcome: Outcome
  reasonCode: string | null
  counts: Record<string, unknown>
  confirmedEffects: Record<string, unknown>[]
  outstandingOperationIds: string[]
  checkpointId: string | null
  endedAt: number
}
export interface RunReceipt {
  requestId: string
  runId?: string | null
  status: 'accepted' | 'pending' | 'cancelled' | 'rejected' | 'interrupted'
  result?: SkillResult | null
  completion?: Promise<SkillResult | null> | null
}
export interface Invocation {
  requestId: string
  kind: 'start' | 'switch'
  skillId: string
  args: Record<string, unknown>
  expectedRunId?: string | null
}
export interface Provenance {
  source?: Source
  actorId?: string
  requestId?: string
  context?: DecisionContext | null
  supervisor?: boolean
}
export interface CommandAgent {
  activeWork: { task?: { runId?: string } } | null
  runtime: {
    previous(command: Record<string, unknown>, options: Provenance): RunReceipt | null
    start(command: Record<string, unknown>, options: Provenance): RunReceipt
    switch(command: Record<string, unknown>, options: Provenance): RunReceipt
  }
}
