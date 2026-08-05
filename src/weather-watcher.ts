import type * as utils from '@iobroker/adapter-core';
import type { weather } from '@m1kad0/hannah-proto';
import type { AgentMessageSender } from './grpc-client';

/** Internal accumulator shape — superset of current + forecast-day fields. */
interface WeatherBucket {
    temperature?: number;
    temperatureMin?: number;
    temperatureMax?: number;
    humidity?: number;
    conditionSummary?: string;
    conditionDetail?: string;
    precipitationMm?: number;
    windSpeedMs?: number;
    windDirectionDeg?: number;
    windDirectionText?: string;
    observedAt?: number;
}

type BucketField = keyof WeatherBucket;

/** Manual state-ID mapping for "custom" mode — current-conditions only, no forecast. */
export interface WeatherCustomMapping {
    /** State ID holding the current temperature (°C) */
    temperature?: string;
    /** State ID holding the current relative humidity (%) */
    humidity?: string;
    /** State ID holding a textual condition description */
    conditionText?: string;
    /** State ID holding current precipitation (mm) */
    precipitationMm?: string;
    /** State ID holding current wind speed (m/s) */
    windSpeedMs?: string;
    /** State ID holding current wind direction as text */
    windDirectionText?: string;
}

/** Config passed to {@link WeatherWatcher.subscribe}. */
export interface WeatherSubscribeConfig {
    /** '' | 'openweathermap' | 'accuweather' | 'daswetter' | 'custom' */
    adapterType: string;
    /** e.g. "0"; ignored when adapterType === 'custom' */
    instance: string;
    /** Only used when adapterType === 'custom' */
    customMapping: WeatherCustomMapping;
}

/** role → WeatherBucket field, for the generic "known adapter" role-scan. */
const ROLE_FIELD_MAP: Record<string, BucketField> = {
    'value.temperature': 'temperature',
    'value.temperature.max': 'temperatureMax',
    'value.temperature.min': 'temperatureMin',
    'value.humidity': 'humidity',
    'weather.state': 'conditionDetail',
    'weather.title': 'conditionSummary',
    'weather.precipitation.rain': 'precipitationMm',
    'weather.precipitation': 'precipitationMm', // fallback if .rain absent
    'value.speed.wind': 'windSpeedMs',
    date: 'observedAt',
};

const TEXT_FIELDS = new Set<BucketField>(['conditionSummary', 'conditionDetail', 'windDirectionText']);

// openweathermap pushes ~15-20 states nearly simultaneously per poll — without this,
// a single poll cycle would fire a burst of near-duplicate AgentWeatherUpdates.
const DEBOUNCE_MS = 2500;

const CUSTOM_FIELD_MAP: ReadonlyArray<[keyof WeatherCustomMapping, BucketField]> = [
    ['temperature', 'temperature'],
    ['humidity', 'humidity'],
    ['conditionText', 'conditionDetail'],
    ['precipitationMm', 'precipitationMm'],
    ['windSpeedMs', 'windSpeedMs'],
    ['windDirectionText', 'windDirectionText'],
];

/**
 * Discovers weather data from a configured source (a known ioBroker weather adapter
 * instance, via generic role-based object scanning, or a manual "custom" datapoint
 * mapping) and forwards it to Hannah Core as AgentWeatherUpdate.
 * Modeled on ResidentsWatcher — not state-watcher.ts's device-discovery pipeline,
 * since weather has no room and isn't a controllable device.
 */
export class WeatherWatcher {
    private adapter: utils.AdapterInstance;
    private send: AgentMessageSender;
    private mode: 'known' | 'custom' | null = null;
    private subscribedIds = new Set<string>();
    // "known" mode: stateId → where its value lands ('current' bucket, or a forecast day offset)
    private knownFieldMap = new Map<string, { bucket: 'current' | number; field: BucketField }>();
    // "custom" mode: stateId → field (current-conditions only)
    private customFieldMap = new Map<string, BucketField>();
    private currentBucket: WeatherBucket = {};
    private forecastBuckets = new Map<number, WeatherBucket>();
    private debounceTimer: ioBroker.Timeout | null | undefined = null;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender) {
        this.adapter = adapter;
        this.send = send;
    }

    /**
     * Discover + subscribe based on config; call once from onConnected.
     *
     * @param config - Weather source selection (known adapter type + instance, or custom mapping)
     */
    async subscribe(config: WeatherSubscribeConfig): Promise<void> {
        if (!config.adapterType) {
            return;
        }
        if (config.adapterType === 'custom') {
            this.mode = 'custom';
            await this._subscribeCustom(config.customMapping);
        } else {
            this.mode = 'known';
            await this._subscribeKnownAdapter(config.adapterType, config.instance || '0');
        }
        this._send();
    }

    /**
     * Call from onForeignStateChange when a subscribed weather state changes.
     *
     * @param id - State ID that changed
     * @param state - New state value, or null/undefined if deleted
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.val === null || state.val === undefined) {
            return;
        }
        if (this.mode === 'custom') {
            const field = this.customFieldMap.get(id);
            if (!field) {
                return;
            }
            this._setField(this.currentBucket, field, state.val);
        } else {
            const target = this.knownFieldMap.get(id);
            if (!target) {
                return;
            }
            const bucket = target.bucket === 'current' ? this.currentBucket : this._forecastBucket(target.bucket);
            this._setField(bucket, target.field, state.val);
        }
        this._scheduleSend();
    }

    /** Unsubscribe all weather states. */
    async unsubscribe(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds.clear();
        this.knownFieldMap.clear();
        this.customFieldMap.clear();
        if (this.debounceTimer) {
            this.adapter.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    // ------------------------------------------------------------------
    // "Known adapter" mode — generic role-based discovery, no hardcoded vendor paths

    private async _subscribeKnownAdapter(adapterType: string, instance: string): Promise<void> {
        const prefix = `${adapterType}.${instance}`;
        let states: Record<string, ioBroker.Object>;
        try {
            states = await this.adapter.getForeignObjectsAsync(`${prefix}.*`, 'state');
        } catch (e) {
            this.adapter.log.error(`[weather] getForeignObjectsAsync failed for ${prefix}: ${(e as Error).message}`);
            return;
        }

        for (const [stateId, obj] of Object.entries(states)) {
            // Bucket comes from the state's own ID, not a parent channel object — real
            // openweathermap only creates a channel object for day0, day1+ are bare states
            // with no parent object at all (#154). "current.<field>"/"dayN.<field>" also
            // naturally excludes 3-hourly "periodN"/"forecast.undefined" paths, since those
            // match neither pattern.
            const bucketMatch = stateId.match(/\.(current|day(\d+))\.[^.]+$/);
            if (!bucketMatch) {
                continue;
            }
            const bucket: 'current' | number = bucketMatch[1] === 'current' ? 'current' : Number(bucketMatch[2]);

            const common = obj?.common as { role?: string; type?: string } | undefined;
            const role = common?.role;
            if (!role) {
                continue;
            }
            // Forecast-day states carry the same base role as their "current" counterpart
            // but with a ".forecast.N" suffix appended (e.g. "value.temperature.max" on
            // current becomes "value.temperature.max.forecast.0" on day0) — strip it before
            // matching so both buckets share the same lookup. No-op for "current" states,
            // which never carry the suffix (#152).
            const baseRole = role.replace(/\.forecast\.\d+$/, '');
            // value.direction.wind is ambiguous — shared by numeric + text variants of the
            // same role — disambiguate via the state's own declared common.type.
            const field: BucketField | undefined =
                baseRole === 'value.direction.wind'
                    ? common?.type === 'number'
                        ? 'windDirectionDeg'
                        : 'windDirectionText'
                    : ROLE_FIELD_MAP[baseRole];
            if (!field) {
                continue;
            }
            this.knownFieldMap.set(stateId, { bucket, field });
            await this.adapter.subscribeForeignStatesAsync(stateId);
            this.subscribedIds.add(stateId);

            const initial = await this.adapter.getForeignStateAsync(stateId);
            if (initial && initial.val !== null && initial.val !== undefined) {
                const target = bucket === 'current' ? this.currentBucket : this._forecastBucket(bucket);
                this._setField(target, field, initial.val);
            }
        }

        this.adapter.log.info(
            `[weather] Known-adapter discovery (${prefix}): ${this.subscribedIds.size} states subscribed.`,
        );
    }

    private _forecastBucket(dayOffset: number): WeatherBucket {
        let bucket = this.forecastBuckets.get(dayOffset);
        if (!bucket) {
            bucket = {};
            this.forecastBuckets.set(dayOffset, bucket);
        }
        return bucket;
    }

    // ------------------------------------------------------------------
    // "Custom" mode — manual datapoint mapping, current-conditions only (v1 scope)

    private async _subscribeCustom(mapping: WeatherCustomMapping): Promise<void> {
        for (const [mappingKey, field] of CUSTOM_FIELD_MAP) {
            const stateId = mapping[mappingKey];
            if (!stateId) {
                continue;
            }
            this.customFieldMap.set(stateId, field);
            await this.adapter.subscribeForeignStatesAsync(stateId);
            this.subscribedIds.add(stateId);

            const initial = await this.adapter.getForeignStateAsync(stateId);
            if (initial && initial.val !== null && initial.val !== undefined) {
                this._setField(this.currentBucket, field, initial.val);
            }
        }
        this.adapter.log.info(`[weather] Custom mapping: ${this.subscribedIds.size} states subscribed.`);
    }

    // ------------------------------------------------------------------
    // Shared: value coercion + send

    private _setField(bucket: WeatherBucket, field: BucketField, raw: ioBroker.StateValue): void {
        if (TEXT_FIELDS.has(field)) {
            (bucket[field] as string | undefined) = String(raw);
            return;
        }
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isNaN(n)) {
            (bucket[field] as number | undefined) = n;
        }
    }

    private _scheduleSend(): void {
        if (this.debounceTimer) {
            this.adapter.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = this.adapter.setTimeout(() => {
            this.debounceTimer = null;
            this._send();
        }, DEBOUNCE_MS);
    }

    private _send(): void {
        const hasCurrent = Object.keys(this.currentBucket).length > 0;
        const current: weather.WeatherCurrentData | undefined = hasCurrent
            ? {
                  temperature: this.currentBucket.temperature ?? 0,
                  humidity: this.currentBucket.humidity,
                  conditionSummary: this.currentBucket.conditionSummary ?? '',
                  conditionDetail: this.currentBucket.conditionDetail ?? '',
                  precipitationMm: this.currentBucket.precipitationMm,
                  windSpeedMs: this.currentBucket.windSpeedMs,
                  windDirectionDeg: this.currentBucket.windDirectionDeg,
                  windDirectionText: this.currentBucket.windDirectionText,
                  observedAt: BigInt(this.currentBucket.observedAt ?? Math.floor(Date.now() / 1000)),
              }
            : undefined;

        const forecast: weather.WeatherForecastDay[] = [...this.forecastBuckets.entries()]
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
