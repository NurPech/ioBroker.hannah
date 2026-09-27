import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import { v1 } from '@m1kad0/hannah-proto';
import shared = v1.shared;
import { StateWatcher, trustLevelSupported } from './state-watcher';

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
    ): Promise<{
        room: string;
        device: string;
        type: string;
        stateType: shared.StateType;
        enumValues: shared.EnumValues | undefined;
        writable: boolean;
        deviceId: string;
        canonicalKey: string;
        inverted: boolean | undefined;
        requiredTrustLevel: number | undefined;
    }>;
    _statesToEnumValues(
        rawStates: Record<string, string> | string[] | string | undefined,
    ): shared.EnumValues | undefined;
    _isManaged(id: string): boolean;
    _extractViewMembers(rows: Array<{ id: string; value: ioBroker.Object | null }>, selected: string[]): Set<string>;
    _subscribeEnumStates(selectedRooms: string[], selectedFunctions: string[]): Promise<void>;
    _sendSnapshot(): Promise<void>;
    trustByState: Map<string, number | undefined>;
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

        const canonicalKeyCases: Array<[string, string]> = [
            ['level.dimmer', 'level'],
            ['switch.light', 'on'],
            ['level.color.rgb', 'color'],
            ['level.temperature', 'expected'],
            ['value.temperature', 'current'],
            ['value.humidity', 'current'],
            ['value.brightness', 'illuminance'],
            ['value.power', 'power'],
            ['sensor.door', 'open'],
            ['indicator.open', 'open'],
            ['sensor.window', 'open'],
            ['level.blind', 'level'],
            ['level.curtain', 'level'],
            ['value.blind', 'level'],
            ['value.curtain', 'level'],
        ];
        for (const [role, expectedCanonicalKey] of canonicalKeyCases) {
            it(`resolves role "${role}" to canonicalKey "${expectedCanonicalKey}" (hannah#257)`, async () => {
                publishState({ role });
                publishDevice();

                const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

                expect(meta.canonicalKey).to.equal(expectedCanonicalKey);
            });
        }

        it('resolves a writable switch/switch.power role to canonicalKey "on" when no function matches', async () => {
            publishState({ role: 'switch.power', write: true });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.canonicalKey).to.equal('on');
        });

        it('leaves canonicalKey empty when type is resolved via function-name fallback (no role match)', async () => {
            publishState({});
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(
                stateId,
                room(deviceId),
                functionsFor(stateId, 'stecker'),
            );

            expect(meta.type).to.equal('socket');
            expect(meta.canonicalKey).to.equal('');
        });

        it('prefers a common.custom canonicalKey override on the state object', async () => {
            publishState({
                role: 'switch.light',
                custom: { 'hannah.0': { enabled: true, canonicalKey: 'custom_key' } },
            });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.canonicalKey).to.equal('custom_key');
        });

        it('ignores a common.custom canonicalKey override on the device object (state-level only)', async () => {
            publishState({ role: 'switch.light' });
            publishDevice({ custom: { 'hannah.0': { enabled: true, canonicalKey: 'device_key' } } });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.canonicalKey).to.equal('on');
        });

        // #203: neededTrust, state-level only; undefined (not 0) means "no restriction".
        it('reports requiredTrustLevel from neededTrust on the state object', async () => {
            publishState({ role: 'switch.lock', custom: { 'hannah.0': { enabled: true, neededTrust: 8 } } });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.requiredTrustLevel).to.equal(8);
        });

        it('keeps an explicit neededTrust of 0 distinct from unset', async () => {
            publishState({ role: 'switch.lock', custom: { 'hannah.0': { enabled: true, neededTrust: 0 } } });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.requiredTrustLevel).to.equal(0);
        });

        const unsetTrustCases: Array<[string, Record<string, unknown>]> = [
            ['no custom entry', {}],
            ['empty neededTrust', { custom: { 'hannah.0': { enabled: true, neededTrust: '' } } }],
            ['override not enabled', { custom: { 'hannah.0': { enabled: false, neededTrust: 8 } } }],
            ['out of range', { custom: { 'hannah.0': { enabled: true, neededTrust: 11 } } }],
            ['not an integer', { custom: { 'hannah.0': { enabled: true, neededTrust: 2.5 } } }],
        ];
        for (const [label, common] of unsetTrustCases) {
            it(`leaves requiredTrustLevel undefined for ${label}`, async () => {
                publishState({ role: 'switch.lock', ...common });
                publishDevice();

                const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

                expect(meta.requiredTrustLevel).to.equal(undefined);
            });
        }

        it('ignores neededTrust on the device object (state-level only)', async () => {
            publishState({ role: 'switch.lock' });
            publishDevice({ custom: { 'hannah.0': { enabled: true, neededTrust: 8 } } });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.requiredTrustLevel).to.equal(undefined);
        });

        // hannah#177/hannah-proto#4: shutterInverted-Override, nur für über die ROLE_TABLE als
        // 'blind' aufgelöste States relevant.
        it('reports inverted=true when shutterInverted is set on the state object of a blind role', async () => {
            publishState({
                role: 'level.blind',
                custom: { 'hannah.0': { enabled: true, shutterInverted: true } },
            });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.inverted).to.equal(true);
        });

        it('falls back to a shutterInverted override on the device object', async () => {
            publishState({ role: 'level.curtain' });
            publishDevice({ custom: { 'hannah.0': { enabled: true, shutterInverted: true } } });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.inverted).to.equal(true);
        });

        it('prefers an explicit state-level shutterInverted=false over a device-level true', async () => {
            publishState({
                role: 'value.blind',
                custom: { 'hannah.0': { enabled: true, shutterInverted: false } },
            });
            publishDevice({ custom: { 'hannah.0': { enabled: true, shutterInverted: true } } });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.inverted).to.equal(false);
        });

        it('leaves inverted undefined (not false) when no override is set on a blind role', async () => {
            publishState({ role: 'value.curtain' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.inverted).to.be.undefined;
        });

        it('ignores shutterInverted when custom override is not enabled', async () => {
            publishState({
                role: 'level.blind',
                custom: { 'hannah.0': { enabled: false, shutterInverted: true } },
            });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.inverted).to.be.undefined;
        });

        it('ignores shutterInverted on a non-blind role, even if set', async () => {
            publishState({
                role: 'switch.light',
                custom: { 'hannah.0': { enabled: true, shutterInverted: true } },
            });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.inverted).to.be.undefined;
        });

        it('prefers a common.custom name override on the state object (hannah#164)', async () => {
            publishState({
                role: 'switch.light',
                name: 'Technical_Name_1',
                custom: { 'hannah.0': { enabled: true, name: 'Stehlampe' } },
            });
            publishDevice({ name: 'Technical_Device_Name' });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.device).to.equal('Stehlampe');
        });

        it('falls back to a common.custom name override on the device object (hannah#164)', async () => {
            publishState({ role: 'switch.light', name: 'Technical_Name_1' });
            publishDevice({
                name: 'Technical_Device_Name',
                custom: { 'hannah.0': { enabled: true, name: 'Stehlampe' } },
            });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.device).to.equal('Stehlampe');
        });

        it('ignores a common.custom name override that is not enabled (hannah#164)', async () => {
            publishState({
                role: 'switch.light',
                name: 'Technical_Name_1',
                custom: { 'hannah.0': { enabled: false, name: 'Stehlampe' } },
            });
            publishDevice({ name: 'Technical_Device_Name' });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.device).to.equal('Technical_Device_Name');
        });

        it('falls back to the device object name when there is no name override (hannah#164)', async () => {
            publishState({ role: 'switch.light', name: 'Technical_Name_1' });
            publishDevice({ name: 'Technical_Device_Name' });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.device).to.equal('Technical_Device_Name');
        });

        it('falls back to the last id segment when neither object nor override has a usable name (hannah#164)', async () => {
            // MockDatabase.publishObject() deep-merges onto a template whose common.name
            // defaults to "an object" — set it explicitly empty to simulate objects with
            // genuinely no usable name, rather than relying on that mock default.
            publishState({ role: 'switch.light', name: '' });
            publishDevice({ name: '' });

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.device).to.equal('Device');
        });

        it("reports deviceId as the state's parent object id (hannah#257)", async () => {
            publishState({ role: 'switch.light' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.deviceId).to.equal(deviceId);
        });

        it('resolves the room via the parent device/channel when the room enum member is the device', async () => {
            publishState({ role: 'switch.light' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.room).to.equal('wohnzimmer');
        });

        it('resolves the room when the room enum member is the state itself instead of the parent device (hannah-iobroker#187)', async () => {
            publishState({ role: 'switch.light' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(stateId), noFunctions);

            expect(meta.room).to.equal('wohnzimmer');
        });

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

        it('resolves a state filed under a "Szene" function as scene', async () => {
            publishState({ role: 'boolean', write: true });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(
                stateId,
                room(deviceId),
                functionsFor(stateId, 'szene'),
            );

            expect(meta.type).to.equal('scene');
        });

        it('resolves a writable switch/switch.power role as socket when no function matches', async () => {
            publishState({ role: 'switch.power', write: true });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('socket');
        });

        it('marks a writable state as writable', async () => {
            publishState({ role: 'switch.light', write: true });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.writable).to.equal(true);
        });

        it('marks a read-only state as not writable', async () => {
            publishState({ role: 'value.temperature', write: false });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.writable).to.equal(false);
        });

        it('treats a missing write flag as not writable', async () => {
            publishState({ role: 'value.temperature' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.writable).to.equal(false);
        });

        it('returns an empty type when nothing matches', async () => {
            publishState({ role: 'unknown.role' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.type).to.equal('');
        });
    });

    describe('_resolveDeviceMeta / resolveStateType (#117)', () => {
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

        it('resolves common.type "boolean" as BOOLEAN', async () => {
            publishState({ type: 'boolean' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.BOOLEAN);
            expect(meta.enumValues).to.be.undefined;
        });

        it('resolves common.type "number" as NUMERIC', async () => {
            publishState({ type: 'number' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.NUMERIC);
            expect(meta.enumValues).to.be.undefined;
        });

        it('resolves common.type "string" with no common.states as TEXT', async () => {
            publishState({ type: 'string' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.TEXT);
            expect(meta.enumValues).to.be.undefined;
        });

        it('resolves a state with common.states (object form) as ENUM with mapped values', async () => {
            publishState({ type: 'number', states: { 0: 'Aus', 1: 'An', 2: 'Auto' } });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.ENUM);
            expect(meta.enumValues?.values).to.deep.equal({ 0: 'Aus', 1: 'An', 2: 'Auto' });
        });

        // Not exercised via publishState()/_resolveDeviceMeta() like the other cases: the
        // @iobroker/testing mock's publishObject() deep-clones common.states through
        // alcalzone-shared's extend(), which turns a real array into a plain object with
        // numeric-string keys ({0: 'rot', ...}) — a mock-only artifact, not real ioBroker
        // behavior. Calling the private helper directly avoids that distortion.
        it('resolves common.states (array form) as ENUM, value used as its own label', () => {
            const values = internals(makeWatcher())._statesToEnumValues(['rot', 'gruen', 'blau']);

            expect(values?.values).to.deep.equal({ rot: 'rot', gruen: 'gruen', blau: 'blau' });
        });

        it('resolves the deprecated "val1:text1;val2:text2" common.states string format as ENUM', async () => {
            publishState({ type: 'number', states: '0:Aus;1:An' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.ENUM);
            expect(meta.enumValues?.values).to.deep.equal({ 0: 'Aus', 1: 'An' });
        });

        it('resolves a level.color role as COLOR, independent of common.type', async () => {
            publishState({ type: 'string', role: 'level.color.rgb' });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.COLOR);
        });

        it('resolves a level.color role with common.states as COLOR, carrying the enum values', async () => {
            publishState({ type: 'string', role: 'level.color', states: { red: 'Rot', blue: 'Blau' } });
            publishDevice();

            const meta = await internals(makeWatcher())._resolveDeviceMeta(stateId, room(deviceId), noFunctions);

            expect(meta.stateType).to.equal(shared.StateType.COLOR);
            expect(meta.enumValues?.values).to.deep.equal({ red: 'Rot', blue: 'Blau' });
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

    describe('_subscribeEnumStates (hannah-iobroker#187)', () => {
        // Enum objects are written straight into the mock database's backing Map, bypassing
        // publishObject()'s extend()-based deep clone — that clone turns a real `members` array
        // into a plain object with numeric-string keys (same mock artifact already noted above
        // for common.states), which would break _extractViewMembers' for-of loop over `members`.
        function publishEnum(id: string, members: string[]): void {
            (database as unknown as { objects: Map<string, ioBroker.Object> }).objects.set(id, {
                _id: id,
                type: 'enum',
                common: { name: '', members } as unknown as ioBroker.EnumCommon,
                native: {},
            });
        }

        it('subscribes a room enum member as a single state, not only as a wildcard prefix, since a room can be assigned directly to a leaf state', async () => {
            const stateId = 'alias.0.EnOcean.Schalten.Wohnzimmer.status';
            publishEnum('enum.rooms.wohnzimmer', [stateId]);
            const sw = internals(makeWatcher());

            await sw._subscribeEnumStates([], []);

            expect(sw.subscribedIds.has(stateId)).to.equal(true);
        });

        it('still subscribes the wildcard prefix for a room enum member that is a real device/channel', async () => {
            const deviceId = 'javascript.0.virtualDevice.Test.Device';
            publishEnum('enum.rooms.wohnzimmer', [deviceId]);
            const sw = internals(makeWatcher());

            await sw._subscribeEnumStates([], []);

            expect(sw.wildcardPrefixes.has(`${deviceId}.`)).to.equal(true);
        });

        it('matches a function state whose id equals a selected room member directly, not only as a child path (both-filters branch)', async () => {
            const stateId = 'alias.0.EnOcean.Schalten.Wohnzimmer.status';
            publishEnum('enum.rooms.wohnzimmer', [stateId]);
            publishEnum('enum.functions.light', [stateId]);
            const sw = internals(makeWatcher());

            await sw._subscribeEnumStates(['enum.rooms.wohnzimmer'], ['enum.functions.light']);

            expect(sw.subscribedIds.has(stateId)).to.equal(true);
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

    // #203/hannah-proto#16
    describe('trustLevelSupported', () => {
        const ack = (unknownFields: Array<{ messageType: string; fieldNumbers: number[] }>): any => ({
            kind: 'ack',
            ack: { ackId: 1n, unknownFields },
        });

        it('is supported when Core acks without reporting AgentDevice field 15', () => {
            expect(trustLevelSupported(ack([]))).to.equal(true);
            expect(trustLevelSupported(ack([{ messageType: 'hannah.v1.AgentDevice', fieldNumbers: [16] }]))).to.equal(
                true,
            );
            expect(trustLevelSupported(ack([{ messageType: 'hannah.v1.Other', fieldNumbers: [15] }]))).to.equal(true);
        });

        it('is unsupported when Core reports AgentDevice field 15 as unknown', () => {
            expect(
                trustLevelSupported(ack([{ messageType: 'hannah.v1.AgentDevice', fieldNumbers: [14, 15] }])),
            ).to.equal(false);
        });

        it('is unsupported on ack timeout and on the unversioned API', () => {
            expect(trustLevelSupported({ kind: 'timeout' })).to.equal(false);
            expect(trustLevelSupported({ kind: 'legacy' })).to.equal(false);
        });

        it('has no verdict when disconnected', () => {
            expect(trustLevelSupported({ kind: 'disconnected' })).to.equal(null);
        });
    });

    describe('snapshot trust support report (#203)', () => {
        const stateId = 'javascript.0.virtualDevice.Test.Device.lock';

        async function snapshotWith(custom: Record<string, unknown> | undefined): Promise<sinon.SinonStub> {
            database.publishObject({
                _id: stateId,
                type: 'state',
                common: { role: 'switch.lock', custom } as unknown as ioBroker.StateCommon,
                native: {},
            });
            // MockAdapter lacks these — _sendSnapshot would swallow the TypeError per pattern
            (adapter as any).getForeignStatesAsync = sinon.stub().resolves({ [stateId]: { val: false, ack: true } });
            (adapter as any).getEnumAsync = sinon.stub().resolves({ result: {} });
            const onTrustSupport = sinon.stub();
            const sendWithAck = sinon.stub().resolves({ kind: 'timeout' });
            const sw = new StateWatcher(adapterInstance, sinon.stub(), sendWithAck, onTrustSupport);
            internals(sw).subscribedIds.add(stateId);

            await internals(sw)._sendSnapshot();
            await Promise.resolve();

            expect(sendWithAck).to.have.been.calledOnce;
            expect(sendWithAck.firstCall.args[0].sendSnapshot.devices).to.have.length(1);
            return onTrustSupport;
        }

        it('reports configured=true when a state has neededTrust set', async () => {
            const onTrustSupport = await snapshotWith({ 'hannah.0': { enabled: true, neededTrust: 8 } });

            expect(onTrustSupport).to.have.been.calledOnceWithExactly(false, true);
        });

        it('reports configured=false when no state has neededTrust set', async () => {
            const onTrustSupport = await snapshotWith(undefined);

            expect(onTrustSupport).to.have.been.calledOnceWithExactly(false, false);
        });
    });

    describe('onObjectChange (#203)', () => {
        const stateId = 'javascript.0.virtualDevice.Test.Device.lock';
        let setTimeoutStub: sinon.SinonStub;

        beforeEach(() => {
            setTimeoutStub = sinon.stub().returns(1);
            (adapter as any).setTimeout = setTimeoutStub;
            (adapter as any).clearTimeout = sinon.stub();
        });

        function stateObj(custom?: Record<string, unknown>): ioBroker.Object {
            return {
                _id: stateId,
                type: 'state',
                common: { role: 'switch.lock', custom } as unknown as ioBroker.StateCommon,
                native: {},
            };
        }

        function managedWatcher(lastSent: number | undefined): StateWatcher {
            const sw = makeWatcher();
            internals(sw).subscribedIds.add(stateId);
            internals(sw).trustByState.set(stateId, lastSent);
            return sw;
        }

        it('schedules a resend when neededTrust changed', () => {
            managedWatcher(undefined).onObjectChange(
                stateId,
                stateObj({ 'hannah.0': { enabled: true, neededTrust: 5 } }),
            );

            expect(setTimeoutStub).to.have.been.calledOnce;
        });

        it('schedules a resend when neededTrust was removed', () => {
            managedWatcher(5).onObjectChange(stateId, stateObj());

            expect(setTimeoutStub).to.have.been.calledOnce;
        });

        it('does nothing when neededTrust is unchanged (other object edits)', () => {
            managedWatcher(5).onObjectChange(stateId, stateObj({ 'hannah.0': { enabled: true, neededTrust: 5 } }));

            expect(setTimeoutStub).to.not.have.been.called;
        });

        it('ignores objects that are not managed', () => {
            makeWatcher().onObjectChange(stateId, stateObj({ 'hannah.0': { enabled: true, neededTrust: 5 } }));

            expect(setTimeoutStub).to.not.have.been.called;
        });
    });
});
