import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import { WeatherWatcher } from './weather-watcher';

const { createMocks } = utils.unit;

describe('WeatherWatcher', () => {
    const { adapter, database } = createMocks({ name: 'hannah' });
    // MockAdapter is structurally close to adapter-core's AdapterInstance but not
    // nominally assignable (private class fields) — cast once, reuse everywhere.
    const adapterInstance = adapter as unknown as adapterCore.AdapterInstance;
    // Not implemented by @iobroker/testing's mock (only I/O methods are) — fire the
    // callback synchronously so debounced sends resolve within the test itself
    // instead of waiting out the real 2.5s delay.
    (adapterInstance as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void) => {
        fn();
        return 0;
    };
    (adapterInstance as unknown as { clearTimeout: unknown }).clearTimeout = () => {};

    afterEach(() => {
        adapter.resetMock();
        database.clear();
    });

    function makeWatcher(): { watcher: WeatherWatcher; send: sinon.SinonStub } {
        const send = sinon.stub();
        return { watcher: new WeatherWatcher(adapterInstance, send), send };
    }

    function publishChannel(id: string, role: string): void {
        database.publishObject({ _id: id, type: 'channel', common: { role }, native: {} });
    }

    function publishState(id: string, role: string, val: unknown, type?: string): void {
        database.publishObject({
            _id: id,
            type: 'state',
            common: { role, ...(type ? { type } : {}) } as any,
            native: {},
        });
        database.publishState(id, { val, ack: true } as any);
    }

    describe('known-adapter discovery', () => {
        it('maps a weather.current channel to AgentWeatherUpdate.current via role-scan', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.current', 'weather.current');
            publishState('openweathermap.0.forecast.current.temperature', 'value.temperature', 8.4);
            publishState('openweathermap.0.forecast.current.state', 'weather.state', 'Regen');
            publishState('openweathermap.0.forecast.current.title', 'weather.title', 'Rain');
            publishState('openweathermap.0.forecast.current.precipitationRain', 'weather.precipitation.rain', 1.2);
            publishState('openweathermap.0.forecast.current.windSpeed', 'value.speed.wind', 8.0);

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });

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

        it('maps day-suffixed weather.forecast channels to forecast days, sorted by day_offset', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.day2', 'weather.forecast');
            publishState('openweathermap.0.forecast.day2.temperatureMax', 'value.temperature.max', 6.0);
            publishChannel('openweathermap.0.forecast.day1', 'weather.forecast');
            publishState('openweathermap.0.forecast.day1.temperatureMax', 'value.temperature.max', 9.0);
            publishState('openweathermap.0.forecast.day1.temperatureMin', 'value.temperature.min', 3.0);

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.forecast.map((d: any) => d.dayOffset)).to.deep.equal([1, 2]);
            expect(msg.weatherUpdate.forecast[0]).to.deep.include({ temperatureMin: 3.0, temperatureMax: 9.0 });
            expect(msg.weatherUpdate.forecast[1]).to.deep.include({ temperatureMax: 6.0 });
        });

        it('excludes periodN channels (openweathermap 3-hourly, not day-granularity)', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.period3', 'weather.forecast');
            publishState('openweathermap.0.forecast.period3.temperatureMax', 'value.temperature.max', 99);

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('excludes a forecast.undefined channel (buggy role suffix)', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.forecast.undefined', 'weather.forecast');
            publishState('openweathermap.0.forecast.forecast.undefined.temperatureMax', 'value.temperature.max', 99);

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('maps a numeric value.direction.wind state to windDirectionDeg', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.current', 'weather.current');
            publishState('openweathermap.0.forecast.current.windDirection', 'value.direction.wind', 270, 'number');

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current.windDirectionDeg).to.equal(270);
            expect(msg.weatherUpdate.current.windDirectionText).to.be.undefined;
        });

        it('maps a string value.direction.wind state to windDirectionText', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.current', 'weather.current');
            publishState(
                'openweathermap.0.forecast.current.windDirectionText',
                'value.direction.wind',
                'Westen',
                'string',
            );

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current.windDirectionText).to.equal('Westen');
            expect(msg.weatherUpdate.current.windDirectionDeg).to.be.undefined;
        });
    });

    describe('custom mapping mode', () => {
        it('subscribes only configured fields, current-conditions only, no forecast', async () => {
            const { watcher, send } = makeWatcher();
            database.publishState('0_userdata.0.aussentemperatur', { val: 12.5, ack: true });
            database.publishState('0_userdata.0.wetterzustand', { val: 'Sonnig', ack: true });

            await watcher.subscribe({
                adapterType: 'custom',
                instance: '0',
                customMapping: {
                    temperature: '0_userdata.0.aussentemperatur',
                    conditionText: '0_userdata.0.wetterzustand',
                },
            });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current).to.deep.include({ temperature: 12.5, conditionDetail: 'Sonnig' });
            expect(msg.weatherUpdate.forecast).to.deep.equal([]);
        });

        it('ignores unconfigured mapping fields', async () => {
            const { watcher, send } = makeWatcher();

            await watcher.subscribe({ adapterType: 'custom', instance: '0', customMapping: {} });

            const msg = send.firstCall.args[0];
            expect(msg.weatherUpdate.current).to.be.undefined;
        });
    });

    describe('onStateChange', () => {
        it('forwards a live update on an already-subscribed state (debounced send)', async () => {
            const { watcher, send } = makeWatcher();
            publishChannel('openweathermap.0.forecast.current', 'weather.current');
            publishState('openweathermap.0.forecast.current.temperature', 'value.temperature', 8.0);

            await watcher.subscribe({ adapterType: 'openweathermap', instance: '0', customMapping: {} });
            send.resetHistory();

            watcher.onStateChange('openweathermap.0.forecast.current.temperature', {
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
            const { watcher, send } = makeWatcher();

            watcher.onStateChange('openweathermap.0.forecast.current.temperature', {
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
            const { watcher, send } = makeWatcher();

            watcher.onStateChange('openweathermap.0.forecast.current.temperature', null);

            expect(send).to.not.have.been.called;
        });
    });

    describe('subscribe', () => {
        it('does nothing when adapterType is empty (disabled)', async () => {
            const { watcher, send } = makeWatcher();

            await watcher.subscribe({ adapterType: '', instance: '0', customMapping: {} });

            expect(send).to.not.have.been.called;
        });
    });
});
