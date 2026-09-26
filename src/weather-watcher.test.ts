import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import { createWeatherSource, type WeatherSource, type WeatherSourceConfig } from './weather-watcher';

const { createMocks } = utils.unit;

describe('WeatherSource', () => {
    const { adapter, database } = createMocks({ name: 'hannah' });
    // MockAdapter is structurally close to adapter-core's AdapterInstance but not
    // nominally assignable (private class fields) — cast once, reuse everywhere.
    const adapterInstance = adapter as unknown as adapterCore.AdapterInstance;
    // Not implemented by @iobroker/testing's mock (only I/O methods are). Debounced sends
    // (2.5s) fire synchronously so they resolve within the test itself; longer delays are
    // clock-driven re-sends (daswetter's hourly "current" slot) — only recorded, since
    // firing them synchronously would re-schedule themselves forever.
    const scheduledDelays: number[] = [];
    (adapterInstance as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => {
        if (ms > 2500) {
            scheduledDelays.push(ms);
            return 1;
        }
        fn();
        return 0;
    };
    (adapterInstance as unknown as { clearTimeout: unknown }).clearTimeout = () => {};

    afterEach(() => {
        adapter.resetMock();
        database.clear();
        scheduledDelays.length = 0;
    });

    function makeSource(config: Partial<WeatherSourceConfig>): { source: WeatherSource; send: sinon.SinonStub } {
        const send = sinon.stub();
        const source = createWeatherSource(adapterInstance, send, {
            adapterType: '',
            instance: '0',
            location: 'location_1',
            customMapping: {},
            ...config,
        });
        if (!source) {
            throw new Error('expected a weather source');
        }
        return { source, send };
    }

    // Real openweathermap only ever creates a channel object for "current" (and,
    // inconsistently, day0) — day1+ are bare states with no parent object at all
    // (#154). Discovery is state-only, so tests deliberately never publish a channel.
    function publishState(id: string, role: string, val: unknown, type?: string): void {
        database.publishObject({
            _id: id,
            type: 'state',
            common: { role, ...(type ? { type } : {}) } as any,
            native: {},
        });
        database.publishState(id, { val, ack: true } as any);
    }

    describe('factory', () => {
        it('returns null when adapterType is empty (disabled)', () => {
            const source = createWeatherSource(adapterInstance, sinon.stub(), {
                adapterType: '',
                instance: '0',
                location: 'location_1',
                customMapping: {},
            });
            expect(source).to.be.null;
        });

        it('keeps the role-based scan for accuweather', async () => {
            const { source, send } = makeSource({ adapterType: 'accuweather' });
            publishState('accuweather.0.forecast.current.temperature', 'value.temperature', 8.4);

            await source.subscribe();

            expect(send.firstCall.args[0].weatherUpdate.current.temperature).to.equal(8.4);
        });
    });

    describe('openweathermap', () => {
        it('maps current-conditions states via role-scan', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState('openweathermap.0.forecast.current.temperature', 'value.temperature', 8.4);
            publishState('openweathermap.0.forecast.current.state', 'weather.state', 'Regen');
            publishState('openweathermap.0.forecast.current.title', 'weather.title', 'Rain');
            publishState('openweathermap.0.forecast.current.precipitationRain', 'weather.precipitation.rain', 1.2);
            publishState('openweathermap.0.forecast.current.windSpeed', 'value.speed.wind', 8.0);

            await source.subscribe();

            expect(send).to.have.been.calledOnce;
            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current).to.deep.include({
                temperature: 8.4,
                conditionDetail: 'Regen',
                conditionSummary: 'Rain',
                precipitationMm: 1.2,
                windSpeedMs: 8.0,
            });
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('maps dayN-suffixed states to forecast days, sorted by day_offset, with no channel object needed (#154)', async () => {
            // Real openweathermap forecast-day roles carry a ".forecast.N" suffix on top of
            // the base role (e.g. "value.temperature.max.forecast.1") — using the real,
            // suffixed form here so this test actually exercises that stripping logic (#152).
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState('openweathermap.0.forecast.day2.temperatureMax', 'value.temperature.max.forecast.2', 6.0);
            publishState('openweathermap.0.forecast.day1.temperatureMax', 'value.temperature.max.forecast.1', 9.0);
            publishState('openweathermap.0.forecast.day1.temperatureMin', 'value.temperature.min.forecast.1', 3.0);

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.forecast.map((d: any) => d.dayOffset)).to.deep.equal([1, 2]);
            expect(msg.weatherUpdate.forecast[0]).to.deep.include({ temperatureMin: 3.0, temperatureMax: 9.0 });
            expect(msg.weatherUpdate.forecast[1]).to.deep.include({ temperatureMax: 6.0 });
        });

        it('strips the .forecast.N role suffix for condition/precipitation/wind on a forecast day (#152)', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState('openweathermap.0.forecast.day1.state', 'weather.state.forecast.1', 'Regen');
            publishState('openweathermap.0.forecast.day1.title', 'weather.title.forecast.1', 'Rain');
            publishState(
                'openweathermap.0.forecast.day1.precipitationRain',
                'weather.precipitation.rain.forecast.1',
                2.5,
            );
            publishState('openweathermap.0.forecast.day1.windSpeed', 'value.speed.wind.forecast.1', 8.0);
            publishState(
                'openweathermap.0.forecast.day1.windDirectionText',
                'value.direction.wind.forecast.1',
                'Westen',
                'string',
            );

            await source.subscribe();

            const msg = send.firstCall.args[0];
            // WeatherForecastDay (unlike WeatherCurrentData) has no windDirectionDeg field on
            // the wire — only windDirectionText — so only the string variant is asserted here.
            expect(msg.weatherUpdate.forecast[0]).to.deep.include({
                conditionDetail: 'Regen',
                conditionSummary: 'Rain',
                precipitationMm: 2.5,
                windSpeedMs: 8.0,
                windDirectionText: 'Westen',
            });
        });

        it('excludes periodN states (openweathermap 3-hourly, not day-granularity)', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState('openweathermap.0.forecast.period3.temperatureMax', 'value.temperature.max.forecast.3', 99);

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('excludes forecast.undefined states (buggy role suffix)', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState(
                'openweathermap.0.forecast.forecast.undefined.temperatureMax',
                'value.temperature.max.forecast.undefined',
                99,
            );

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('maps a numeric value.direction.wind state to windDirectionDeg', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState('openweathermap.0.forecast.current.windDirection', 'value.direction.wind', 270, 'number');

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current.windDirectionDeg).to.equal(270);
            expect(msg.weatherUpdate.current.windDirectionText).to.be.undefined;
        });

        it('maps a string value.direction.wind state to windDirectionText', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState(
                'openweathermap.0.forecast.current.windDirectionText',
                'value.direction.wind',
                'Westen',
                'string',
            );

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current.windDirectionText).to.equal('Westen');
            expect(msg.weatherUpdate.current.windDirectionDeg).to.be.undefined;
        });
    });

    describe('daswetter', () => {
        // Fixed local "now": 2026-09-26 10:15. Only Date is faked — timers stay on the
        // adapter mock above.
        const NOW = new Date(2026, 8, 26, 10, 15).getTime();
        const local = (day: number, hour: number): number => new Date(2026, 8, day, hour).getTime();
        const loc = 'daswetter.0.location_1';
        let clock: sinon.SinonFakeTimers;

        beforeEach(() => {
            clock = sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
        });
        afterEach(() => {
            clock.restore();
        });

        // Roles are deliberately the real (misleading) daswetter ones — mapping must
        // not depend on them.
        function publishDay(n: number, start: number | undefined, fields: Record<string, unknown>): void {
            if (start !== undefined) {
                publishState(`${loc}.ForecastDaily.Day_${n}.start`, 'date', start, 'number');
            }
            for (const [name, val] of Object.entries(fields)) {
                publishState(`${loc}.ForecastDaily.Day_${n}.${name}`, 'value.speed.wind.forecast.0', val);
            }
        }

        function publishHour(n: number, end: number | undefined, fields: Record<string, unknown>): void {
            if (end !== undefined) {
                publishState(`${loc}.ForecastHourly.Hour_${n}.end`, 'date', end, 'number');
            }
            for (const [name, val] of Object.entries(fields)) {
                publishState(`${loc}.ForecastHourly.Hour_${n}.${name}`, 'value.temperature.max.forecast.0', val);
            }
        }

        it('maps daily states by name, day offset from start (Unix seconds), wind km/h → m/s', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            publishDay(1, local(26, 0) / 1000, {
                Temperature_Max: 21,
                Temperature_Min: 9,
                Rain: 0.4,
                Wind_Speed: 36,
                Wind_Speed_Beauforts: 5,
                Wind_Direction: 'SW',
                symbol_description: 'Bewölkt',
                Humidity: 70,
            });
            publishDay(2, local(27, 0) / 1000, { Temperature_Max: 18 });

            await source.subscribe();

            const forecast = send.firstCall.args[0].weatherUpdate.forecast;
            expect(forecast.map((d: any) => d.dayOffset)).to.deep.equal([0, 1]);
            expect(forecast[0]).to.deep.include({
                temperatureMax: 21,
                temperatureMin: 9,
                precipitationMm: 0.4,
                windDirectionText: 'SW',
                conditionDetail: 'Bewölkt',
            });
            expect(forecast[0].windSpeedMs).to.be.closeTo(10, 1e-9);
            expect(forecast[1]).to.deep.include({ temperatureMax: 18 });
        });

        it('skips days that are already past and accepts start in milliseconds', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            // Stale download from yesterday: Day_1 is yesterday, Day_2 is today.
            publishDay(1, local(25, 0), { Temperature_Max: 30 });
            publishDay(2, local(26, 0), { Temperature_Max: 20 });

            await source.subscribe();

            const forecast = send.firstCall.args[0].weatherUpdate.forecast;
            expect(forecast).to.have.length(1);
            expect(forecast[0]).to.deep.include({ dayOffset: 0, temperatureMax: 20 });
        });

        it('falls back to Day_N → offset N-1 when a day has no start timestamp', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            publishDay(1, undefined, { Temperature_Max: 21 });
            publishDay(3, undefined, { Temperature_Max: 15 });

            await source.subscribe();

            const forecast = send.firstCall.args[0].weatherUpdate.forecast;
            expect(forecast.map((d: any) => d.dayOffset)).to.deep.equal([0, 2]);
        });

        it('takes current conditions from the hourly slot containing now and re-sends when it ends', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            publishHour(1, local(26, 10), { temperature: 12 });
            publishHour(2, local(26, 11), {
                temperature: 14,
                humidity: 60,
                rain: 0.1,
                wind_speed: 18,
                wind_speed_Beauforts: 3,
                wind_direction: 'W',
                symbol_description: 'Leichter Regen',
            });
            publishHour(3, local(26, 12), { temperature: 16 });

            await source.subscribe();

            const current = send.firstCall.args[0].weatherUpdate.current;
            expect(current).to.deep.include({
                temperature: 14,
                humidity: 60,
                precipitationMm: 0.1,
                windDirectionText: 'W',
                conditionDetail: 'Leichter Regen',
            });
            expect(current.windSpeedMs).to.be.closeTo(5, 1e-9);
            expect(scheduledDelays).to.deep.equal([local(26, 11) - NOW]);
        });

        it('falls back to Hour_1 when no hourly slot carries an end timestamp', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            publishHour(1, undefined, { temperature: 12 });
            publishHour(2, undefined, { temperature: 14 });

            await source.subscribe();

            expect(send.firstCall.args[0].weatherUpdate.current.temperature).to.equal(12);
        });

        it('sends no current conditions when every hourly slot has already ended', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            publishHour(1, local(26, 9), { temperature: 12 });
            publishHour(2, local(26, 10), { temperature: 14 });

            await source.subscribe();

            expect(send.firstCall.args[0].weatherUpdate.current).to.be.undefined;
        });

        it('only reads the configured location', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter', location: 'location_2' });
            publishDay(1, local(26, 0), { Temperature_Max: 21 });
            publishState('daswetter.0.location_2.ForecastDaily.Day_1.start', 'date', local(26, 0), 'number');
            publishState('daswetter.0.location_2.ForecastDaily.Day_1.Temperature_Max', 'value', 5);

            await source.subscribe();

            const forecast = send.firstCall.args[0].weatherUpdate.forecast;
            expect(forecast).to.have.length(1);
            expect(forecast[0].temperatureMax).to.equal(5);
        });

        it('forwards a live update into the right bucket', async () => {
            const { source, send } = makeSource({ adapterType: 'daswetter' });
            publishDay(1, local(26, 0), { Temperature_Max: 21 });

            await source.subscribe();
            send.resetHistory();

            source.onStateChange(`${loc}.ForecastDaily.Day_1.Temperature_Max`, {
                val: 23,
                ack: true,
                ts: 0,
                lc: 0,
                from: '',
                q: 0,
            });

            expect(send).to.have.been.calledOnce;
            expect(send.firstCall.args[0].weatherUpdate.forecast[0].temperatureMax).to.equal(23);
        });
    });

    describe('custom mapping mode', () => {
        it('subscribes only configured fields, current-conditions only, no forecast', async () => {
            database.publishState('0_userdata.0.aussentemperatur', { val: 12.5, ack: true });
            database.publishState('0_userdata.0.wetterzustand', { val: 'Sonnig', ack: true });
            const { source, send } = makeSource({
                adapterType: 'custom',
                customMapping: {
                    temperature: '0_userdata.0.aussentemperatur',
                    conditionText: '0_userdata.0.wetterzustand',
                },
            });

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current).to.deep.include({ temperature: 12.5, conditionDetail: 'Sonnig' });
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('ignores unconfigured mapping fields', async () => {
            const { source, send } = makeSource({ adapterType: 'custom' });

            await source.subscribe();

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current).to.be.undefined;
        });
    });

    describe('onStateChange', () => {
        it('forwards a live update on an already-subscribed state (debounced send)', async () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });
            publishState('openweathermap.0.forecast.current.temperature', 'value.temperature', 8.0);

            await source.subscribe();
            send.resetHistory();

            source.onStateChange('openweathermap.0.forecast.current.temperature', {
                val: 11.0,
                ack: true,
                ts: 0,
                lc: 0,
                from: '',
                q: 0,
            });

            expect(send).to.have.been.calledOnce;
            expect(send.firstCall.args[0].weatherUpdate.current.temperature).to.equal(11.0);
        });

        it('ignores a state that was never discovered/subscribed', () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });

            source.onStateChange('openweathermap.0.forecast.current.temperature', {
                val: 11.0,
                ack: true,
                ts: 0,
                lc: 0,
                from: '',
                q: 0,
            });

            expect(send).to.not.have.been.called;
        });

        it('ignores a null state', () => {
            const { source, send } = makeSource({ adapterType: 'openweathermap' });

            source.onStateChange('openweathermap.0.forecast.current.temperature', null);

            expect(send).to.not.have.been.called;
        });
    });
});
