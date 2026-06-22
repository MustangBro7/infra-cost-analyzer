import type { Attribution, Provider } from "../types"

export type AnalyticsSource = "live" | "d1_backfill" | "retry"
export type AnalyticsWriteStatus = "written" | "queued" | "disabled"

export interface AnalyticsCostObservation {
  observationId: string
  factKey: string
  providerAccountId: string | null
  provider: Provider
  serviceName: string
  resourceId: string | null
  resourceName: string | null
  billingPeriodStart: string
  billingPeriodEnd: string
  cost: number
  currency: string
  attribution: Attribution
  attributionReason: string
  signalId: string | null
  attributedRepo: string | null
  itemKey: string
}

export interface AnalyticsUsageObservation {
  observationId: string
  factKey: string
  provider: Provider
  planName: string
  service: string
  used: number | null
  limit: number | null
  unit: string
  remaining: number | null
  percentUsed: number | null
  source: "measured" | "allowance"
  note: string
}

export interface AnalyticsResourceObservation {
  observationId: string
  factKey: string
  provider: Provider
  itemKey: string
  kind: string
  name: string
  quantity: number
  unit: string
  attributedRepo: string | null
}

export interface AnalyticsPayload {
  syncRunId: string
  userId: string
  snapshotKey: string
  repoFullName: string | null
  periodStart: string
  periodEnd: string
  computedAt: string
  source: AnalyticsSource
  costs: AnalyticsCostObservation[]
  usage: AnalyticsUsageObservation[]
  resources: AnalyticsResourceObservation[]
}

export interface AnalyticsWriteResult {
  status: AnalyticsWriteStatus
  syncRunId: string | null
}

export interface TrendPoint {
  month: string
  currency: string
  total: number
  lastObservedAt: string
}

export interface BreakdownPoint {
  provider: string
  serviceName?: string
  currency: string
  total: number
  lastObservedAt: string
}

export interface AnalyticsTrendsResult {
  from: string
  to: string
  repo: string | null
  trends: TrendPoint[]
  providers: Array<BreakdownPoint & { month: string }>
  lastObservedAt: string | null
}

export interface AnalyticsServicesResult {
  month: string
  repo: string | null
  services: BreakdownPoint[]
  lastObservedAt: string | null
}

export interface AnalyticsDashboardResult {
  trends: AnalyticsTrendsResult
  services: AnalyticsServicesResult
}
