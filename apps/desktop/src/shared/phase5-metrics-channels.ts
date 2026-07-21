export const PHASE5_METRICS_CHANNELS = Object.freeze({
  cardPaintProbe: 'phase5-metrics:card-paint-probe',
  cardPaintAck: 'phase5-metrics:card-paint-ack'
} as const);

export interface Phase5PaintTokenPayload {
  readonly token: number;
}

export function isPhase5PaintTokenPayload(value: unknown): value is Phase5PaintTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1
    && Number.isSafeInteger(record.token)
    && Number(record.token) > 0
    && Number(record.token) <= 2_147_483_647;
}
