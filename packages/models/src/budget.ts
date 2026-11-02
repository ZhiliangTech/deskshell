import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface DailyModelLimits { maxRequests: number; maxEstimatedCostUsd: number }
export const DEFAULT_DAILY_MODEL_LIMITS: Readonly<DailyModelLimits> = Object.freeze({ maxRequests: 10, maxEstimatedCostUsd: 0.10 });
export interface BudgetUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface ModelBudgetReservation { reservationToken: string; provider: "deepseek"; model: "deepseek-flash"; estimatedCostUsd: number }
export interface ModelBudgetTicket { reservationToken: string; billingDay: string; estimatedCostUsd: number }
export interface ModelBudgetSettlement {
  status: "succeeded" | "failed" | "cancelled" | "unknown";
  estimatedCostUsd: number;
  requestId?: string;
  model?: string;
  usage?: BudgetUsage | null;
  errorCode?: string;
}
export interface ModelBudgetHook {
  reserve(input: ModelBudgetReservation): ModelBudgetTicket;
  settle(ticket: ModelBudgetTicket, outcome: ModelBudgetSettlement): { accountedCostUsd: number; dailyLimitExceeded: boolean };
}
export interface BudgetRequestRecord {
  reservationToken: string; billingDay: string; provider: string; requestedModel: string;
  reservedCostUsd: number; accountedCostUsd: number; status: string; startedAt: string;
  settledAt: string | null; requestId: string | null; returnedModel: string | null; usage: BudgetUsage | null; errorCode: string | null;
}
export interface ModelBudgetSnapshot {
  billingDay: string; clockDay: string; clockRollbackDetected: boolean; timezone: "UTC";
  limits: DailyModelLimits; usedRequests: number; reservedCostUsd: number; remainingRequests: number;
  remainingEstimatedCostUsd: number; inFlightRequests: number; recentRequests: BudgetRequestRecord[];
}
export class BudgetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "BudgetError"; this.code = code; }
}

const APPLICATION_ID = 0x44534231; // DSB1: never adopt another SQLite database.
const NANO_USD = 1_000_000_000;
type Row = Record<string, unknown>;
const fail = (code: string, message: string): never => { throw new BudgetError(code, message); };
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !names.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) {
    fail("INVALID_BUDGET_ARGUMENT", "Budget inputs must contain only supported plain fields");
  }
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) fail("INVALID_BUDGET_ARGUMENT", "Invalid budget identifier");
}
function nanos(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) fail("INVALID_BUDGET_ARGUMENT", "Estimated USD must be between zero and 1000");
  // Decimal scaling avoids Math.ceil(binaryFloat * scale) adding another nano on a returned ticket.
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction); const power = 9 + Number(exponent) - fraction.length;
  if (power >= 0) return Number(digits * 10n ** BigInt(power));
  const divisor = 10n ** BigInt(-power); return Number((digits + divisor - 1n) / divisor);
}
function checkedLimits(value: DailyModelLimits): { maxRequests: number; maxCost: number } {
  fields(value, ["maxRequests", "maxEstimatedCostUsd"]);
  if (!Number.isSafeInteger(value.maxRequests) || value.maxRequests < 0 || value.maxRequests > 1000) fail("INVALID_BUDGET_ARGUMENT", "Daily request limit must be an integer from zero to 1000");
  return { maxRequests: value.maxRequests, maxCost: nanos(value.maxEstimatedCostUsd) };
}
function settlement(value: ModelBudgetSettlement): { json: string; amount: number; normalized: ModelBudgetSettlement } {
  fields(value, ["status", "estimatedCostUsd", "requestId", "model", "usage", "errorCode"]);
  if (!["succeeded", "failed", "cancelled", "unknown"].includes(value.status)) fail("INVALID_BUDGET_ARGUMENT", "Invalid settlement status");
  const amount = nanos(value.estimatedCostUsd);
  if (value.requestId !== undefined) identifier(value.requestId);
  if (value.model !== undefined) identifier(value.model);
  if (value.errorCode !== undefined && (typeof value.errorCode !== "string" || !/^[A-Z0-9_]{1,80}$/.test(value.errorCode))) fail("INVALID_BUDGET_ARGUMENT", "Invalid settlement error code");
  let usage: BudgetUsage | null = null;
  if (value.usage !== undefined && value.usage !== null) {
    fields(value.usage, ["promptTokens", "completionTokens", "totalTokens"]);
    for (const token of [value.usage.promptTokens, value.usage.completionTokens, value.usage.totalTokens]) {
      if (!Number.isSafeInteger(token) || token < 0) fail("INVALID_BUDGET_ARGUMENT", "Invalid usage counters");
    }
    if (value.usage.totalTokens < value.usage.promptTokens + value.usage.completionTokens) fail("INVALID_BUDGET_ARGUMENT", "Invalid usage total");
    usage = { promptTokens: value.usage.promptTokens, completionTokens: value.usage.completionTokens, totalTokens: value.usage.totalTokens };
  }
  const normalized: ModelBudgetSettlement = {
    status: value.status, estimatedCostUsd: amount / NANO_USD,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }), ...(value.model === undefined ? {} : { model: value.model }), usage,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
  return { json: JSON.stringify(normalized), amount, normalized };
}

/** Durable conservative accounting, shared by local processes. No prompts, bodies or credentials are stored. */
export class ModelBudget implements ModelBudgetHook {
  readonly databasePath: string;
  #db: DatabaseSync;
  #now: () => Date;
  #closed = false;

  constructor(dataDir: string, options: { initialLimits?: DailyModelLimits; now?: () => Date } = {}) {
    if (typeof dataDir !== "string" || !dataDir.trim()) fail("INVALID_BUDGET_ARGUMENT", "A budget directory is required");
    fields(options, ["initialLimits", "now"]);
    if (options.now !== undefined && typeof options.now !== "function") fail("INVALID_BUDGET_ARGUMENT", "Invalid budget clock");
    this.#now = options.now ?? (() => new Date());
    const initial = checkedLimits(options.initialLimits ?? { ...DEFAULT_DAILY_MODEL_LIMITS });
    this.databasePath = path.join(path.resolve(dataDir), "model-budget.sqlite");
    let database: DatabaseSync | undefined;
    try {
      fs.mkdirSync(path.resolve(dataDir), { recursive: true, mode: 0o700 });
      for (const file of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail("BUDGET_STORE_FAILED", "Linked budget files are unsupported");
      }
      database = new DatabaseSync(this.databasePath); this.#db = database;
      database.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
      this.#transaction(() => {
        const version = Number(database!.prepare("PRAGMA user_version").get()?.user_version);
        const application = Number(database!.prepare("PRAGMA application_id").get()?.application_id);
        if (version === 0 && application === 0) {
          if (database!.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) fail("BUDGET_STORE_FAILED", "Refusing to adopt an unrelated budget database");
          database!.exec(`
            CREATE TABLE config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_requests INTEGER NOT NULL,
              max_cost_nanos INTEGER NOT NULL, high_day TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
            CREATE TABLE requests(reservation_token TEXT PRIMARY KEY, provider TEXT NOT NULL, requested_model TEXT NOT NULL,
              billing_day TEXT NOT NULL, reserved_nanos INTEGER NOT NULL, accounted_nanos INTEGER NOT NULL, status TEXT NOT NULL,
              started_at TEXT NOT NULL, settled_at TEXT, request_id TEXT, returned_model TEXT, usage_json TEXT, error_code TEXT, settlement_json TEXT) STRICT;
            CREATE INDEX requests_by_day ON requests(billing_day);
            CREATE TABLE config_changes(id INTEGER PRIMARY KEY, changed_at TEXT NOT NULL, previous_json TEXT NOT NULL, current_json TEXT NOT NULL) STRICT;
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          `);
          const clock = this.#clock();
          database!.prepare("INSERT INTO config VALUES(1,?,?,?,?)").run(initial.maxRequests, initial.maxCost, clock.day, clock.iso);
        } else if (version !== 1 || application !== APPLICATION_ID) fail("BUDGET_STORE_FAILED", "Unrecognized budget database version");
        const config = this.#config();
        if (options.initialLimits !== undefined && (config.max_requests !== initial.maxRequests || config.max_cost_nanos !== initial.maxCost)) {
          fail("BUDGET_CONFIG_MISMATCH", "The stored daily limits differ; use explicit configure to change them");
        }
      });
      const check = database.prepare("PRAGMA quick_check").all();
      if (check.length !== 1 || Object.values(check[0])[0] !== "ok") fail("BUDGET_STORE_FAILED", "Budget integrity check failed");
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    } catch (error) {
      try { database?.close(); } catch { /* Never expose an underlying database exception. */ }
      this.#closed = true;
      if (error instanceof BudgetError) throw error;
      fail("BUDGET_STORE_FAILED", "The persistent model budget could not be opened");
    }
  }

  #clock(): { day: string; iso: string } {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getUTCFullYear() < 1000 || now.getUTCFullYear() > 9999) fail("INVALID_BUDGET_CLOCK", "The budget clock is invalid");
    const iso = now.toISOString(); return { day: iso.slice(0, 10), iso };
  }
  #transaction<T>(work: () => T): T {
    if (this.#closed) fail("BUDGET_STORE_FAILED", "The model budget is closed");
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      try { const result = work(); this.#db.exec("COMMIT"); return result; }
      catch (error) { try { this.#db.exec("ROLLBACK"); } catch { /* Preserve only sanitized error types. */ } throw error; }
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      fail("BUDGET_STORE_FAILED", "Persistent budget accounting failed");
    }
  }
  #config(): Row {
    const config = this.#db.prepare("SELECT * FROM config WHERE singleton=1").get();
    if (!config || !Number.isSafeInteger(config.max_requests) || Number(config.max_requests) < 0 || Number(config.max_requests) > 1000
        || !Number.isSafeInteger(config.max_cost_nanos) || Number(config.max_cost_nanos) < 0 || Number(config.max_cost_nanos) > 1000 * NANO_USD
        || typeof config.high_day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(config.high_day)) fail("BUDGET_STORE_FAILED", "The budget configuration is invalid");
    return config;
  }
  #day(): { billingDay: string; clockDay: string; clockRollbackDetected: boolean; iso: string; config: Row } {
    const clock = this.#clock(); const config = this.#config();
    const billingDay = clock.day > String(config.high_day) ? clock.day : String(config.high_day);
    if (billingDay !== config.high_day) this.#db.prepare("UPDATE config SET high_day=?,updated_at=? WHERE singleton=1").run(billingDay, clock.iso);
    return { billingDay, clockDay: clock.day, clockRollbackDetected: clock.day < billingDay, iso: clock.iso, config };
  }
  #totals(day: string): { requests: number; amount: number; pending: number } {
    const row = this.#db.prepare("SELECT count(*) AS requests, coalesce(sum(accounted_nanos),0) AS amount, coalesce(sum(CASE WHEN status='reserved' THEN 1 ELSE 0 END),0) AS pending FROM requests WHERE billing_day=?").get(day)!;
    if (![row.requests, row.amount, row.pending].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)) fail("BUDGET_STORE_FAILED", "The budget counters are invalid");
    return { requests: Number(row.requests), amount: Number(row.amount), pending: Number(row.pending) };
  }
  #ticket(row: Row): ModelBudgetTicket {
    return { reservationToken: String(row.reservation_token), billingDay: String(row.billing_day), estimatedCostUsd: Number(row.reserved_nanos) / NANO_USD };
  }
  reserve(input: ModelBudgetReservation): ModelBudgetTicket {
    fields(input, ["reservationToken", "provider", "model", "estimatedCostUsd"]); identifier(input.reservationToken);
    if (input.provider !== "deepseek" || input.model !== "deepseek-flash") fail("INVALID_BUDGET_ARGUMENT", "Unsupported model budget identity");
    const amount = nanos(input.estimatedCostUsd);
    if (amount === 0) fail("INVALID_BUDGET_ARGUMENT", "A positive cost reservation is required");
    // Remember an observed new UTC day even if the subsequent admission is denied.
    this.#transaction(() => this.#day());
    return this.#transaction(() => {
      const day = this.#day();
      const previous = this.#db.prepare("SELECT * FROM requests WHERE reservation_token=?").get(input.reservationToken);
      if (previous) {
        if (previous.provider !== input.provider || previous.requested_model !== input.model || previous.reserved_nanos !== amount) fail("BUDGET_RESERVATION_CONFLICT", "The reservation token already identifies another request");
        return this.#ticket(previous);
      }
      const total = this.#totals(day.billingDay);
      if (total.requests >= Number(day.config.max_requests) || total.amount + amount > Number(day.config.max_cost_nanos)) fail("DAILY_BUDGET_EXCEEDED", "The persistent daily model budget is exhausted");
      this.#db.prepare("INSERT INTO requests(reservation_token,provider,requested_model,billing_day,reserved_nanos,accounted_nanos,status,started_at) VALUES(?,?,?,?,?,?,'reserved',?)")
        .run(input.reservationToken, input.provider, input.model, day.billingDay, amount, amount, day.iso);
      return { reservationToken: input.reservationToken, billingDay: day.billingDay, estimatedCostUsd: amount / NANO_USD };
    });
  }
  settle(ticket: ModelBudgetTicket, outcome: ModelBudgetSettlement): { accountedCostUsd: number; dailyLimitExceeded: boolean } {
    fields(ticket, ["reservationToken", "billingDay", "estimatedCostUsd"]); identifier(ticket.reservationToken);
    const reserved = nanos(ticket.estimatedCostUsd); const result = settlement(outcome);
    this.#transaction(() => this.#day());
    return this.#transaction(() => {
      const day = this.#day();
      const row = this.#db.prepare("SELECT * FROM requests WHERE reservation_token=?").get(ticket.reservationToken);
      if (!row || row.billing_day !== ticket.billingDay || row.reserved_nanos !== reserved) fail("BUDGET_RESERVATION_NOT_FOUND", "A matching persistent reservation is required");
      const accounted = Math.max(Number(row.reserved_nanos), result.amount);
      if (row.settlement_json !== null && row.settlement_json !== result.json) fail("BUDGET_SETTLEMENT_CONFLICT", "The reservation already has a different settlement");
      if (row.settlement_json === null) {
        this.#db.prepare("UPDATE requests SET accounted_nanos=?,status=?,settled_at=?,request_id=?,returned_model=?,usage_json=?,error_code=?,settlement_json=? WHERE reservation_token=?")
          .run(accounted, result.normalized.status, day.iso, result.normalized.requestId ?? null, result.normalized.model ?? null,
            result.normalized.usage ? JSON.stringify(result.normalized.usage) : null, result.normalized.errorCode ?? null, result.json, ticket.reservationToken);
      }
      const total = this.#totals(String(row.billing_day));
      return { accountedCostUsd: accounted / NANO_USD, dailyLimitExceeded: total.requests > Number(day.config.max_requests) || total.amount > Number(day.config.max_cost_nanos) };
    });
  }
  /** Explicit trusted settings action. It changes limits, never clears reservations or historical usage. */
  configure(limits: DailyModelLimits): ModelBudgetSnapshot {
    const checked = checkedLimits(limits);
    this.#transaction(() => this.#day());
    this.#transaction(() => {
      const day = this.#day();
      const before = { maxRequests: Number(day.config.max_requests), maxEstimatedCostUsd: Number(day.config.max_cost_nanos) / NANO_USD };
      const after = { maxRequests: checked.maxRequests, maxEstimatedCostUsd: checked.maxCost / NANO_USD };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.#db.prepare("INSERT INTO config_changes(changed_at,previous_json,current_json) VALUES(?,?,?)").run(day.iso, JSON.stringify(before), JSON.stringify(after));
        this.#db.prepare("UPDATE config SET max_requests=?,max_cost_nanos=?,updated_at=? WHERE singleton=1").run(checked.maxRequests, checked.maxCost, day.iso);
      }
    });
    return this.snapshot();
  }
  snapshot(): ModelBudgetSnapshot {
    return this.#transaction(() => {
      const day = this.#day(); const total = this.#totals(day.billingDay);
      const recentRequests = this.#db.prepare("SELECT * FROM requests ORDER BY started_at DESC,reservation_token DESC LIMIT 20").all().map((row): BudgetRequestRecord => ({
        reservationToken: String(row.reservation_token), billingDay: String(row.billing_day), provider: String(row.provider), requestedModel: String(row.requested_model),
        reservedCostUsd: Number(row.reserved_nanos) / NANO_USD, accountedCostUsd: Number(row.accounted_nanos) / NANO_USD, status: String(row.status), startedAt: String(row.started_at),
        settledAt: row.settled_at as string | null, requestId: row.request_id as string | null, returnedModel: row.returned_model as string | null,
        usage: typeof row.usage_json === "string" ? JSON.parse(row.usage_json) as BudgetUsage : null, errorCode: row.error_code as string | null,
      }));
      return { billingDay: day.billingDay, clockDay: day.clockDay, clockRollbackDetected: day.clockRollbackDetected, timezone: "UTC",
        limits: { maxRequests: Number(day.config.max_requests), maxEstimatedCostUsd: Number(day.config.max_cost_nanos) / NANO_USD },
        usedRequests: total.requests, reservedCostUsd: total.amount / NANO_USD,
        remainingRequests: Math.max(0, Number(day.config.max_requests) - total.requests), remainingEstimatedCostUsd: Math.max(0, Number(day.config.max_cost_nanos) - total.amount) / NANO_USD,
        inFlightRequests: total.pending, recentRequests };
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } catch { fail("BUDGET_STORE_FAILED", "The model budget could not be closed"); }
  }
}
