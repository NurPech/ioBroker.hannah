import type * as utils from '@iobroker/adapter-core';
import { v1 } from '@m1kad0/hannah-proto';
import weather = v1.weather;
import type { AgentMessageSender } from './grpc-client';

/** Internal accumulator shape — superset of current + forecast-day fields. */
export interface WeatherBucket {
    /** Current temperature (°C) */
    temperature?: number;
    /** Forecast minimum temperature (°C) */
    temperatureMin?: number;
    /** Forecast maximum temperature (°C) */
    temperatureMax?: number;
    /** Relative humidity (%) */
    humidity?: number;
    /** Short condition title */
    conditionSummary?: string;
    /** Condition description as spoken by Hannah */
    conditionDetail?: string;
    /** Precipitation (mm) */
    precipitationMm?: number;
    /** Wind speed (m/s) */
    windSpeedMs?: number;
    /** Wind direction (degrees) */
    windDirectionDeg?: number;
    /** Wind direction as text */
    windDirectionText?: string;
    /** Observation time (Unix seconds) */
    observedAt?: number;
}

export type BucketField = keyof WeatherBucket;

/** Where a single subscribed state's value lands in the snapshot. */
export interface StateTarget {
    /** 'current' bucket, or a forecast day offset (0 = today) */
    bucket: 'current' | number;
    /** Target field within the bucket */
    field: BucketField;
    /** Optional numeric conversion applied before storing (e.g. km/h → m/s) */
    transform?: (n: number) => number;
}

/** Everything a source hands to the base class for one AgentWeatherUpdate. */
export interface WeatherSnapshot {
    /** Current conditions */
    current: WeatherBucket;
    /** Forecast buckets by day offset (0 = today) */
    forecast: Map<number, WeatherBucket>;
}

const TEXT_FIELDS = new Set<BucketField>(['conditionSummary', 'conditionDetail', 'windDirectionText']);

// Weather adapters push many states nearly simultaneously per poll — without this,
// a single poll cycle would fire a burst of near-duplicate AgentWeatherUpdates.
const DEBOUNCE_MS = 2500;

/**
 * Coerces a raw state value into a bucket field (text fields → string, all others → number).
 *
 * @param bucket - Bucket to write into
 * @param field - Target field
 * @param raw - Raw ioBroker state value
 * @param transform - Optional numeric conversion
 */
export function setField(
    bucket: WeatherBucket,
    field: BucketField,
    raw: ioBroker.StateValue,
    transform?: (n: number) => number,
): void {
    if (TEXT_FIELDS.has(field)) {
        (bucket[field] as string | undefined) = String(raw);
        return;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isNaN(n)) {
        (bucket[field] as number | undefined) = transform ? transform(n) : n;
    }
}

/**
 * Base class for one configured weather source. Owns subscription bookkeeping, the raw
 * value cache, debouncing and the AgentWeatherUpdate send; subclasses only decide which
 * states to watch ({@link discover}) and — if a fixed stateId → field mapping isn't
 * enough — how to turn the cached values into a snapshot ({@link buildSnapshot}).
 */
export abstract class WeatherSource {
    protected readonly adapter: utils.AdapterInstance;
    /** Latest known value per subscribed state ID */
    protected readonly values = new Map<string, ioBroker.StateValue>();
    /** Fixed stateId → target mapping, used by the default {@link buildSnapshot} */
    protected readonly targets = new Map<string, StateTarget>();
    private readonly send: AgentMessageSender;
    private subscribedIds = new Set<string>();
    private debounceTimer: ioBroker.Timeout | null | undefined = null;
    private resendTimer: ioBroker.Timeout | null | undefined = null;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender) {
        this.adapter = adapter;
        this.send = send;
    }

    /** Short label for log lines, e.g. "daswetter.0". */
    protected abstract get label(): string;

    /** Returns the state IDs to subscribe to. May fill {@link targets} along the way. */
    protected abstract discover(): Promise<string[]>;

    /** Discover + subscribe + send the initial snapshot; call once from onConnected. */
    async subscribe(): Promise<void> {
        const ids = await this.discover();
        for (const id of ids) {
            await this.adapter.subscribeForeignStatesAsync(id);
            this.subscribedIds.add(id);
            const initial = await this.adapter.getForeignStateAsync(id);
            if (initial && initial.val !== null && initial.val !== undefined) {
                this.values.set(id, initial.val);
            }
        }
        this.adapter.log.info(`[weather] ${this.label}: ${this.subscribedIds.size} states subscribed.`);
        this._send();
    }

    /**
     * Call from onForeignStateChange when a subscribed weather state changes.
     *
     * @param id - State ID that changed
     * @param state - New state value, or null/undefined if deleted
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.val === null || state.val === undefined || !this.subscribedIds.has(id)) {
            return;
        }
        this.values.set(id, state.val);
        this._scheduleSend();
    }

    /** Unsubscribe all weather states and cancel pending timers. */
    async unsubscribe(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds.clear();
        this.values.clear();
        this.targets.clear();
        this._clearTimer('debounceTimer');
        this._clearTimer('resendTimer');
    }

    /** Default snapshot: apply {@link targets} to the cached values. */
    protected buildSnapshot(): WeatherSnapshot {
        const snapshot: WeatherSnapshot = { current: {}, forecast: new Map() };
        for (const [id, target] of this.targets) {
            const raw = this.values.get(id);
            if (raw === undefined) {
                continue;
            }
            const bucket = target.bucket === 'current' ? snapshot.current : forecastBucket(snapshot, target.bucket);
            setField(bucket, target.field, raw, target.transform);
        }
        return snapshot;
    }

    /**
     * Re-send the snapshot at a given time even without state changes — for sources whose
     * "current" slot moves with the clock. Replaces any previously scheduled re-send.
     *
     * @param atMs - Unix timestamp (ms) to re-send at
     */
    protected scheduleResendAt(atMs: number): void {
        this._clearTimer('resendTimer');
        const delay = Math.max(1000, atMs - Date.now());
        this.resendTimer = this.adapter.setTimeout(() => {
            this.resendTimer = null;
            this._send();
        }, delay);
    }

    private _clearTimer(which: 'debounceTimer' | 'resendTimer'): void {
        const timer = this[which];
        if (timer) {
            this.adapter.clearTimeout(timer);
            this[which] = null;
        }
    }

    private _scheduleSend(): void {
        this._clearTimer('debounceTimer');
        this.debounceTimer = this.adapter.setTimeout(() => {
            this.debounceTimer = null;
            this._send();
        }, DEBOUNCE_MS);
    }

    private _send(): void {
        const snapshot = this.buildSnapshot();
        const c = snapshot.current;
        const hasCurrent = Object.keys(c).length > 0;
        const current: weather.WeatherCurrentData | undefined = hasCurrent
            ? {
                  temperature: c.temperature ?? 0,
                  humidity: c.humidity,
                  conditionSummary: c.conditionSummary ?? '',
                  conditionDetail: c.conditionDetail ?? '',
                  precipitationMm: c.precipitationMm,
                  windSpeedMs: c.windSpeedMs,
                  windDirectionDeg: c.windDirectionDeg,
                  windDirectionText: c.windDirectionText,
                  observedAt: BigInt(c.observedAt ?? Math.floor(Date.now() / 1000)),
              }
            : undefined;

        const forecast: weather.WeatherForecastDay[] = [...snapshot.forecast.entries()]
            .sort(([a], [b]) => a - b)
            .map(([dayOffset, b]) => ({
                dayOffset,
                temperatureMin: b.temperatureMin,
                temperatureMax: b.temperatureMax,
                conditionSummary: b.conditionSummary ?? '',
                conditionDetail: b.conditionDetail ?? '',
                precipitationMm: b.precipitationMm,
                windSpeedMs: b.windSpeedMs,
                windDirectionText: b.windDirectionText,
            }));

        this.send({ weatherUpdate: { current, forecast } });
        this.adapter.log.debug(
            `[weather] Sent AgentWeatherUpdate (current=${hasCurrent}, forecast days=${forecast.length})`,
        );
    }
}

/**
 * Returns the forecast bucket for a day offset, creating it on first use.
 *
 * @param snapshot - Snapshot being built
 * @param dayOffset - 0 = today
 */
export function forecastBucket(snapshot: WeatherSnapshot, dayOffset: number): WeatherBucket {
    let bucket = snapshot.forecast.get(dayOffset);
    if (!bucket) {
        bucket = {};
        snapshot.forecast.set(dayOffset, bucket);
    }
    return bucket;
}
