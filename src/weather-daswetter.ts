import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';
import {
    WeatherSource,
    forecastBucket,
    setField,
    type BucketField,
    type WeatherBucket,
    type WeatherSnapshot,
} from './weather-source';

const kmhToMs = (kmh: number): number => kmh / 3.6;

interface FieldSpec {
    field: BucketField;
    transform?: (n: number) => number;
}

// daswetter's common.role values are unreliable for mapping (Wind_Speed and
// Wind_Speed_Beauforts share one role, every day carries ".forecast.0", hourly
// temperature is tagged ".max") — map by state name instead.
const DAILY_FIELDS: Record<string, FieldSpec> = {
    Temperature_Max: { field: 'temperatureMax' },
    Temperature_Min: { field: 'temperatureMin' },
    Rain: { field: 'precipitationMm' },
    Wind_Speed: { field: 'windSpeedMs', transform: kmhToMs },
    Wind_Direction: { field: 'windDirectionText' },
    symbol_description: { field: 'conditionDetail' },
};

const HOURLY_FIELDS: Record<string, FieldSpec> = {
    temperature: { field: 'temperature' },
    humidity: { field: 'humidity' },
    rain: { field: 'precipitationMm' },
    wind_speed: { field: 'windSpeedMs', transform: kmhToMs },
    wind_direction: { field: 'windDirectionText' },
    symbol_description: { field: 'conditionDetail' },
};

/** Timing states, not mapped to a field but needed to place days/hours in time. */
const DAY_START = 'start';
const HOUR_END = 'end';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * daswetter: one location's ForecastDaily.Day_N (1-based) and ForecastHourly.Hour_N.
 * There's no "current conditions" channel — current comes from the hourly slot whose
 * window contains now, and day offsets are derived from each day's own start timestamp,
 * so a delayed download never shifts days or hours.
 */
export class DasWetterSource extends WeatherSource {
    private readonly prefix: string;
    /** Day_N → state name → state ID */
    private days = new Map<number, Map<string, string>>();
    /** Hour_N → state name → state ID */
    private hours = new Map<number, Map<string, string>>();

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param instance - daswetter instance number, e.g. "0"
     * @param location - Location channel, e.g. "location_1"
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender, instance: string, location: string) {
        super(adapter, send);
        this.prefix = `daswetter.${instance}.${location}`;
    }

    protected get label(): string {
        return this.prefix;
    }

    protected async discover(): Promise<string[]> {
        let states: Record<string, ioBroker.Object>;
        try {
            states = await this.adapter.getForeignObjectsAsync(`${this.prefix}.*`, 'state');
        } catch (e) {
            this.adapter.log.error(
                `[weather] getForeignObjectsAsync failed for ${this.prefix}: ${(e as Error).message}`,
            );
            return [];
        }

        const ids: string[] = [];
        for (const stateId of Object.keys(states)) {
            const daily = stateId.match(/\.ForecastDaily\.Day_(\d+)\.([^.]+)$/);
            if (daily && (daily[2] in DAILY_FIELDS || daily[2] === DAY_START)) {
                slot(this.days, Number(daily[1])).set(daily[2], stateId);
                ids.push(stateId);
                continue;
            }
            const hourly = stateId.match(/\.ForecastHourly\.Hour_(\d+)\.([^.]+)$/);
            if (hourly && (hourly[2] in HOURLY_FIELDS || hourly[2] === HOUR_END)) {
                slot(this.hours, Number(hourly[1])).set(hourly[2], stateId);
                ids.push(stateId);
            }
        }
        if (ids.length === 0) {
            this.adapter.log.warn(`[weather] No daswetter forecast states found under ${this.prefix}.`);
        }
        return ids;
    }

    protected buildSnapshot(): WeatherSnapshot {
        const snapshot: WeatherSnapshot = { current: {}, forecast: new Map() };

        const todayStart = startOfLocalDay(Date.now());
        for (const [n, names] of this.days) {
            const startMs = this._timestamp(names.get(DAY_START));
            // Day_1 is assumed to be today only when the day carries no start timestamp.
            const offset = startMs !== undefined ? Math.round((startOfLocalDay(startMs) - todayStart) / DAY_MS) : n - 1;
            if (offset < 0) {
                continue;
            }
            this._apply(forecastBucket(snapshot, offset), names, DAILY_FIELDS);
        }

        const currentHour = this._currentHour();
        if (currentHour) {
            this._apply(snapshot.current, currentHour, HOURLY_FIELDS);
        }
        return snapshot;
    }

    /**
     * The hourly slot whose window contains now: the earliest one that hasn't ended yet.
     * Schedules a re-send for when it ends, since "current" moves without any state change.
     * Falls back to Hour_1 only if no slot carries an end timestamp at all.
     */
    private _currentHour(): Map<string, string> | undefined {
        const now = Date.now();
        let best: { names: Map<string, string>; end: number } | undefined;
        let anyEnd = false;
        for (const names of this.hours.values()) {
            const end = this._timestamp(names.get(HOUR_END));
            if (end === undefined) {
                continue;
            }
            anyEnd = true;
            if (end > now && (!best || end < best.end)) {
                best = { names, end };
            }
        }
        if (best) {
            this.scheduleResendAt(best.end);
            return best.names;
        }
        return anyEnd ? undefined : this.hours.get(1);
    }

    private _apply(bucket: WeatherBucket, names: Map<string, string>, fields: Record<string, FieldSpec>): void {
        for (const [name, id] of names) {
            const spec = fields[name];
            const raw = this.values.get(id);
            if (spec && raw !== undefined) {
                setField(bucket, spec.field, raw, spec.transform);
            }
        }
    }

    /**
     * Cached timestamp state as ms — accepts both Unix seconds and milliseconds.
     *
     * @param id - Timestamp state ID
     */
    private _timestamp(id: string | undefined): number | undefined {
        const raw = id ? this.values.get(id) : undefined;
        if (raw === undefined || raw === null || raw === '') {
            return undefined;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
            return undefined;
        }
        return n < 1e12 ? n * 1000 : n;
    }
}

function slot(map: Map<number, Map<string, string>>, n: number): Map<string, string> {
    let names = map.get(n);
    if (!names) {
        names = new Map();
        map.set(n, names);
    }
    return names;
}

function startOfLocalDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
