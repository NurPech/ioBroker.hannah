import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';
import { WeatherSource, type BucketField } from './weather-source';

/** role → WeatherBucket field, for the role-based scan. */
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

/**
 * openweathermap: discovers "current.<field>" / "dayN.<field>" states and maps them
 * via their common.role.
 */
export class OpenWeatherMapSource extends WeatherSource {
    private readonly prefix: string;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param adapterType - Adapter name (namespace prefix), e.g. "openweathermap"
     * @param instance - Instance number, e.g. "0"
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender, adapterType: string, instance: string) {
        super(adapter, send);
        this.prefix = `${adapterType}.${instance}`;
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
            this.targets.set(stateId, { bucket, field });
        }
        return [...this.targets.keys()];
    }
}
