// Replay analysis shared by Clipper and the database. Canonical source lives in
// packages/replay-analysis; each app has a synced copy (npm run sync-packages).
export * from './types'
export { detectCombos, DEFAULT_COMBO_TIMEOUT } from './combos'
export {
  detectEdgeguard,
  findEdgeguards,
  currentStockStart,
  DEFAULT_EDGEGUARD_OPTS,
} from './edgeguard'
export type {
  DetectOpts,
  Detection,
  EdgeguardEvent,
  EdgeguardMetrics,
  Rect,
} from './edgeguard'
export { detectPhantoms, frameBounds } from './phantom'
export type { PhantomEvent, PhantomMetrics } from './phantom'
export { getDeathDirection } from './deaths'
export type { DeathDirection } from './deaths'
export * from './stageGeometry'
export { default as stageGeometry } from './stageGeometry'
export { getRecoveryRange, DEFAULT_RECOVERY_RANGE } from './recoveryData'
export { default as recoveryRanges } from './recoveryData'
