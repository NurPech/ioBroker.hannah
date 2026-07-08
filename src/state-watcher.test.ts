import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import { StateWatcher } from './state-watcher';

const { createMocks } = utils.unit;

/**
 * Accesses private members of StateWatcher for direct unit testing — pragmatic
 * given none of this is reachable through a narrower public surface without
 * spinning up the full start()/_sendSnapshot() machinery (#69).
 */
type StateWatcherInternals = {
    _resolveDeviceMeta(
        stateId: string,
        allRooms: { result: Record<string, any> },
        allFunctions: { result: Record<string, any> },
    ): Promise<{ type: string }>;
    _isManaged(id: string): boolean;
    _extractViewMembers(rows: Array<{ id: string; value: ioBroker.Object | null }>, selected: string[]): Set<string>;
    subscribedIds: Set<string>;
    wildcardPrefixes: Set<string>;
    verifiedWildcardCache: Set<string>;
    watchMoreIds: Set<string>;
};

function internals(sw: StateWatcher): StateWatcherInternals {
    return sw as unknown as StateWatcherInternals;
}

describe('StateWatcher', () => {
    const { adapter, database } = createMocks({ name: 'hannah' });
    // MockAdapter is structurally close to adapter-core's AdapterInstance but not
    // nominally assignable (private class fields) — cast once, reuse everywhere.
    const adapterInstance = adapter as unknown as adapterCore.AdapterInstance;

    afterEach(() => {
        adapter.resetMock();
        database.clear();
    });

    function makeWatcher(): StateWatcher {
        return new StateWatcher(adapterInstance, sinon.stub());
    }

    function room(deviceId: string): { result: Record<string, any> } {
        return {
            result: {
                'enum.rooms.wohnzimmer': {
                    _id: 'enum.rooms.wohnzimmer',
                    type: 'enum',
                    common: { name: 'Wohnzimmer', members: [deviceId] },
                },
            },
        };
    }

    const noFunctions = { result: {} };

    /**
     * resolveType()'s function-name fallback matches against the enum's own _id
     * (`funcIds = matchingFunctionObjs.map(obj => obj._id.toLowerCase())`), not its
     * display name — enumIdSuffix must contain the keyword being tested.
     *
     * @param stateId - The state the function enum's members must include
     * @param enumIdSuffix - Appended to `enum.functions.` and matched against by resolveType()
     * @param name - Display name for the enum (defaults to enumIdSuffix, rarely relevant)
     */
    function functionsFor(stateId: string, enumIdSuffix: string, name = enumIdSuffix): { result: Record<string, any> } {
        const id = `enum.functions.${enumIdSuffix}`;
        return {
            result: {
                [id]: {
                    _id: id,
                    type: 'enum',
                    common: { name, members: [stateId] },
                },
            },
        };
    }

    describe('_resolveDeviceMeta / resolveType', () => {
        const stateId = 'javascript.0.virtualDevice.Test.Device.state';
        const deviceId = 'javascript.0.virtualDevice.Test.Device';

        function publishState(common: Partial<ioBroker.StateCommon>): void {
            database.publishObject({
                _id: stateId,
                type: 'state',
                common: common as unknown as ioBroker.StateCommon,
                native: {},
            });
        }

        function publishDevice(common: Record<string, unknown> = {}): void {
            database.publishObject({
                _id: deviceId,
                type: 'device',
                common: common as unknown as ioBroker.ObjectCommon,
                native: {},
            });
        }

        it('prefers a common.custom override on the state object', async () => {
            publishState({
                role: 'switch.light',
                custom: { 'hannah.0': { enabled: true, type: 'custom_override' } },
            });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('custom_override');
        });

        it('falls back to a common.custom override on the device object', async () => {
            publishState({ role: 'switch.light' });
            publishDevice({ custom: { 'hannah.0': { enabled: true, type: 'device_override' } } });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('device_override');
        });

        it('ignores a custom override that is not enabled', async () => {
            publishState({
                role: 'switch.light',
                custom: { 'hannah.0': { enabled: false, type: 'custom_override' } },
            });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('light');
        });

        const roleCases: Array<[string, string]> = [
            ['level.dimmer', 'light'],
            ['switch.light', 'light'],
            ['level.color.rgb', 'light'],
            ['level.temperature', 'thermostat'],
            ['value.temperature', 'temperature_sensor'],
            ['value.humidity', 'humidity_sensor'],
            ['value.brightness', 'illuminance_sensor'],
            ['sensor.door', 'door'],
            ['indicator.open', 'door'],
            ['sensor.window', 'window'],
            ['level.blind', 'blind'],
            ['level.curtain', 'blind'],
            ['value.blind', 'blind'],
            ['value.curtain', 'blind'],
        ];
        for (const [role, expectedType] of roleCases) {
            it(`resolves role "${role}" as "${expectedType}"`, async () => {
                publishState({ role });
                publishDevice();

                const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

                expect(meta.type).to.equal(expectedType);
            });
        }

        const functionNameCases: Array<[string, string]> = [
            ['licht', 'light'],
            ['stecker', 'socket'],
            ['heizung', 'thermostat'],
            ['fenster', 'window'],
            ['tueren', 'door'],
            ['temperatur', 'temperature_sensor'],
            ['klima', 'climate'],
        ];
        for (const [enumIdSuffix, expectedType] of functionNameCases) {
            it(`falls back to function enum id containing "${enumIdSuffix}" as "${expectedType}"`, async () => {
                publishState({});
                publishDevice();

                const meta = await internals(makeWatcher())._resolveDeviceMeta(
                    stateId,
                    room(deviceId),
                    functionsFor(stateId, enumIdSuffix),
                );

                expect(meta.type).to.equal(expectedType);
            });
        }

        it('recognizes a read-only brightness state filed under a "Licht" function as illuminance_sensor', () => {
            // Regression guard: a writable light must never be misdetected as a sensor just
            // because it happens to sit under the same "Licht" function as read-only lux sensors.
            return (async () => {
                publishState({ role: undefined, write: false });
                publishDevice();

                const meta = await internals(makeWatcher())._resolveDeviceMeta(
                    stateId,
                    room(deviceId),
                    functionsFor(stateId, 'helligkeit'),
                );

                expect(meta.type).to.equal('illuminance_sensor');
            })();
        });

        it('does not misdetect a writable light as illuminance_sensor', async () => {
            publishState({ write: true });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(
                stateId,
                room(deviceId),
                functionsFor(stateId, 'licht'),
            );

            expect(meta.type).to.equal('light');
        });

        it('resolves a writable switch/switch.power role as socket when no function matches', async () => {
            publishState({ role: 'switch.power', write: true });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('socket');
        });

        it('returns an empty type when nothing matches', async () => {
            publishState({ role: 'unknown.role' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('');
        });
    });

    describe('_isManaged', () => {
        it('recognizes an exactly subscribed id', () => {
            const sw = internals(makeWatcher());
            sw.subscribedIds.add('hannah.0.some.state');

            expect(sw._isManaged('hannah.0.some.state')).to.equal(true);
        });

        it('recognizes an id already verified against a wildcard prefix', () => {
            const sw = internals(makeWatcher());
            sw.verifiedWildcardCache.add('hannah.0.some.state');

            expect(sw._isManaged('hannah.0.some.state')).to.equal(true);
        });

        it('recognizes an id matching a wildcard prefix', () => {
            const sw = internals(makeWatcher());
            sw.wildcardPrefixes.add('hannah.0.some.');

            expect(sw._isManaged('hannah.0.some.state')).to.equal(true);
        });

        it('rejects an id that matches nothing', () => {
            const sw = internals(makeWatcher());
            sw.subscribedIds.add('hannah.0.other.state');

            expect(sw._isManaged('hannah.0.some.state')).to.equal(false);
        });
    });

    describe('_extractViewMembers', () => {
        const rows = [
            {
                id: 'enum.rooms.wohnzimmer',
                value: { _id: 'enum.rooms.wohnzimmer', type: 'enum', common: { members: ['dev.a', 'dev.b'] } } as any,
            },
            {
                id: 'enum.rooms.kueche',
                value: { _id: 'enum.rooms.kueche', type: 'enum', common: { members: ['dev.c'] } } as any,
            },
        ];

        it('collects members from all rows when nothing is selected', () => {
            const sw = internals(makeWatcher());

            const result = sw._extractViewMembers(rows, []);

            expect([...result].sort()).to.deep.equal(['dev.a', 'dev.b', 'dev.c']);
        });

        it('only collects members from selected enum ids', () => {
            const sw = internals(makeWatcher());

            const result = sw._extractViewMembers(rows, ['enum.rooms.kueche']);

            expect([...result]).to.deep.equal(['dev.c']);
        });

        it('ignores rows without an enum value', () => {
            const sw = internals(makeWatcher());

            const result = sw._extractViewMembers([{ id: 'enum.rooms.leer', value: null }], []);

            expect(result.size).to.equal(0);
        });
    });

    describe('onStateChange', () => {
        function makeState(overrides: Partial<ioBroker.State> = {}): ioBroker.State {
            return { val: 'x', ack: true, ts: 0, lc: 0, from: '', q: 0, ...overrides };
        }

        it('ignores a state that is not subscribed', () => {
            const sw = makeWatcher();

            expect(sw.onStateChange('hannah.0.unmanaged.state', makeState())).to.equal(false);
        });

        it('ignores a null state', () => {
            const sw = makeWatcher();
            internals(sw).subscribedIds.add('hannah.0.some.state');

            expect(sw.onStateChange('hannah.0.some.state', null)).to.equal(false);
        });

        it('forwards a confirmed (ack=true) subscribed state as AgentStateUpdate', () => {
            const send = sinon.stub();
            const sw = new StateWatcher(adapterInstance, send);
            internals(sw).subscribedIds.add('hannah.0.some.state');

            const handled = sw.onStateChange('hannah.0.some.state', makeState({ val: 42, ack: true }));

            expect(handled).to.equal(true);
            expect(send).to.have.been.calledOnce;
            const msg = send.firstCall.args[0];
            expect(msg.stateUpdate.stateId).to.equal('hannah.0.some.state');
            expect(msg.stateUpdate.value).to.equal('42');
        });

        it('drops an unconfirmed (ack=false) subscribed state', () => {
            const send = sinon.stub();
            const sw = new StateWatcher(adapterInstance, send);
            internals(sw).subscribedIds.add('hannah.0.some.state');

            const handled = sw.onStateChange('hannah.0.some.state', makeState({ ack: false }));

            expect(handled).to.equal(false);
            expect(send).to.not.have.been.called;
        });

        it('forwards an unconfirmed WatchMore state regardless of ack (monitoring-only, no feedback-loop risk)', () => {
            const send = sinon.stub();
            const sw = new StateWatcher(adapterInstance, send);
            internals(sw).watchMoreIds.add('hannah.0.watched.state');

            const handled = sw.onStateChange('hannah.0.watched.state', makeState({ val: 1, ack: false }));

            expect(handled).to.equal(true);
            expect(send).to.have.been.calledOnce;
        });
    });
});
