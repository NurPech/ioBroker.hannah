import { expect } from 'chai';
import { DeviceDetector } from './device-detection';
import {
    describeDiagnostic,
    explainDiscovery,
    severityOf,
    type Diagnostic,
    type DiscoveryConfig,
} from './device-diagnostics';
import { resolveDeviceMeta, type ObjectMap } from './device-meta';
import { buildTypedDevices, type CollectedState } from './device-snapshot';

function stateObject(id: string, common: Record<string, unknown>): ioBroker.Object {
    return { _id: id, type: 'state', common: { name: '', write: true, ...common }, native: {} } as ioBroker.Object;
}

function container(id: string, type = 'device'): ioBroker.Object {
    return { _id: id, type, common: { name: id.split('.').pop() }, native: {} } as unknown as ioBroker.Object;
}

function enumObject(id: string, members: string[]): ioBroker.Object {
    return { _id: id, type: 'enum', common: { name: id.split('.').pop(), members }, native: {} } as ioBroker.Object;
}

/**
 * Resolves every state like the adapter does, from plain objects.
 *
 * @param values - The current value of every state by ID
 * @param objects - The objects of the states and their parents
 * @param enums - The room and function enums
 */
function collect(
    values: Record<string, unknown>,
    objects: ObjectMap,
    enums: Record<string, ioBroker.Object>,
): CollectedState[] {
    const rooms = Object.fromEntries(Object.entries(enums).filter(([id]) => id.startsWith('enum.rooms.')));
    const functions = Object.fromEntries(Object.entries(enums).filter(([id]) => id.startsWith('enum.functions.')));
    return Object.entries(values).map(([id, val]) => ({
        id,
        state: { val: val as ioBroker.StateValue },
        meta: resolveDeviceMeta(id, objects, rooms, functions, { namespace: 'hannah.0', floorMappings: [] }).meta,
    }));
}

/**
 * Runs the typed device building and returns what it explained.
 *
 * @param values - The current value of every state by ID
 * @param objects - The objects of the states and their parents
 * @param enums - The room and function enums
 */
function explainedBuild(
    values: Record<string, unknown>,
    objects: ObjectMap,
    enums: Record<string, ioBroker.Object>,
): Diagnostic[] {
    const found: Diagnostic[] = [];
    buildTypedDevices(collect(values, objects, enums), {}, enums, d => found.push(d));
    return found;
}

describe('device-diagnostics', () => {
    describe('explaining the typed devices', () => {
        const lamp = 'x.0.Lamp';
        const room = { 'enum.rooms.wohnzimmer': enumObject('enum.rooms.wohnzimmer', [lamp]) };

        it('says a device without room is not reported', () => {
            const objects: ObjectMap = { [`${lamp}.on`]: stateObject(`${lamp}.on`, { role: 'switch.light' }) };

            const found = explainedBuild({ [`${lamp}.on`]: true }, objects, {});

            expect(found).to.deep.equal([{ code: 'no-room', deviceId: lamp, stateIds: [`${lamp}.on`] }]);
        });

        it('says a device none of whose states Hannah knows is not reported', () => {
            const cfg = 'x.0.Cfg';
            const objects: ObjectMap = { [`${cfg}.foo`]: stateObject(`${cfg}.foo`, { type: 'boolean' }) };
            const enums = { 'enum.rooms.flur': enumObject('enum.rooms.flur', [cfg]) };

            const found = explainedBuild({ [`${cfg}.foo`]: true }, objects, enums);

            expect(found).to.deep.equal([{ code: 'no-recognized-slot', deviceId: cfg, stateIds: [`${cfg}.foo`] }]);
        });

        it('says which state of a reported device stays a generic slot, and why', () => {
            const objects: ObjectMap = {
                [`${lamp}.on`]: stateObject(`${lamp}.on`, { role: 'switch.light', type: 'boolean' }),
                [`${lamp}.weird`]: stateObject(`${lamp}.weird`, { type: 'number' }),
            };

            const found = explainedBuild({ [`${lamp}.on`]: true, [`${lamp}.weird`]: 3 }, objects, room);

            expect(found).to.deep.equal([
                { code: 'state-generic', deviceId: lamp, stateId: `${lamp}.weird`, key: 'weird', role: '' },
            ]);
        });

        it('lists the states that fit one slot with no clear winner, and does not call them unknown as well', () => {
            const objects: ObjectMap = {
                [`${lamp}.on`]: stateObject(`${lamp}.on`, { role: 'switch.light', type: 'boolean' }),
                [`${lamp}.soll1`]: stateObject(`${lamp}.soll1`, { role: 'level.temperature', type: 'number' }),
                [`${lamp}.soll2`]: stateObject(`${lamp}.soll2`, { role: 'level.temperature', type: 'number' }),
            };

            const found = explainedBuild(
                { [`${lamp}.on`]: true, [`${lamp}.soll1`]: 20, [`${lamp}.soll2`]: 22 },
                objects,
                room,
            );

            expect(found).to.deep.equal([
                {
                    code: 'slot-ambiguous',
                    deviceId: lamp,
                    slot: 'target_temperature',
                    candidates: [`${lamp}.soll1`, `${lamp}.soll2`],
                    remaining: [`${lamp}.soll1`, `${lamp}.soll2`],
                },
            ]);
        });

        it('says a state in the unit of another quantity is not used', () => {
            const objects: ObjectMap = {
                [`${lamp}.on`]: stateObject(`${lamp}.on`, { role: 'switch.light', type: 'boolean' }),
                [`${lamp}.power`]: stateObject(`${lamp}.power`, { role: 'value.power', type: 'number', unit: 'mA' }),
            };

            const found = explainedBuild({ [`${lamp}.on`]: true, [`${lamp}.power`]: 120 }, objects, room);

            expect(found).to.deep.equal([
                { code: 'unit-mismatch', deviceId: lamp, stateId: `${lamp}.power`, slot: 'power', unit: 'mA' },
            ]);
        });

        it('says channels were merged, and that the relays of a multi-relay plug stay apart', () => {
            const kitchen = 'dev.0.Kueche';
            const plug = 'dev.0.Plug';
            const objects: ObjectMap = {
                [`${kitchen}.1.on`]: stateObject(`${kitchen}.1.on`, { role: 'switch.light', type: 'boolean' }),
                [`${kitchen}.2.level`]: stateObject(`${kitchen}.2.level`, { role: 'level.dimmer', type: 'number' }),
                [`${plug}.1.on`]: stateObject(`${plug}.1.on`, { role: 'switch.light', type: 'boolean' }),
                [`${plug}.2.on`]: stateObject(`${plug}.2.on`, { role: 'switch.light', type: 'boolean' }),
            };
            const enums = {
                'enum.rooms.kueche': enumObject('enum.rooms.kueche', [kitchen, plug]),
                'enum.functions.licht': enumObject('enum.functions.licht', [kitchen, plug]),
            };

            const found = explainedBuild(
                {
                    [`${kitchen}.1.on`]: true,
                    [`${kitchen}.2.level`]: 40,
                    [`${plug}.1.on`]: true,
                    [`${plug}.2.on`]: false,
                },
                objects,
                enums,
            );

            expect(found).to.deep.include({
                code: 'merged',
                deviceId: kitchen,
                groupIds: [`${kitchen}.1`, `${kitchen}.2`],
            });
            expect(found).to.deep.include({
                code: 'merge-blocked',
                deviceId: plug,
                groupIds: [`${plug}.1`, `${plug}.2`],
            });
        });

        it('builds the same devices with and without an explain callback', () => {
            const objects: ObjectMap = {
                [`${lamp}.on`]: stateObject(`${lamp}.on`, { role: 'switch.light', type: 'boolean' }),
                [`${lamp}.weird`]: stateObject(`${lamp}.weird`, { type: 'number' }),
                [`${lamp}.soll1`]: stateObject(`${lamp}.soll1`, { role: 'level.temperature', type: 'number' }),
                [`${lamp}.soll2`]: stateObject(`${lamp}.soll2`, { role: 'level.temperature', type: 'number' }),
            };
            const values = { [`${lamp}.on`]: true, [`${lamp}.weird`]: 3, [`${lamp}.soll1`]: 20, [`${lamp}.soll2`]: 22 };
            const collected = collect(values, objects, room);

            const plain = buildTypedDevices(collected, {}, room);
            const explained = buildTypedDevices(collected, {}, room, () => undefined);

            expect(explained.model.devices).to.deep.equal(plain.model.devices);
            expect(explained.merges).to.deep.equal(plain.merges);
        });
    });

    describe('explaining the detection', () => {
        it('says a state the detector took for a switch is none', () => {
            const objects: Record<string, ioBroker.Object> = {
                'zigbee.0.motion': container('zigbee.0.motion', 'channel'),
                'zigbee.0.motion.occupancy': stateObject('zigbee.0.motion.occupancy', {
                    role: 'sensor.motion',
                    type: 'boolean',
                    write: false,
                }),
                'zigbee.0.motion.led_indication': stateObject('zigbee.0.motion.led_indication', {
                    role: 'state',
                    type: 'boolean',
                }),
            };
            const found: Diagnostic[] = [];

            new DeviceDetector(objects).detect('zigbee.0.motion', d => found.push(d));

            expect(found).to.deep.equal([{ code: 'switch-implausible', stateId: 'zigbee.0.motion.led_indication' }]);
        });
    });

    describe('explainDiscovery', () => {
        const rooms = {
            'enum.rooms.wohnzimmer': enumObject('enum.rooms.wohnzimmer', ['a.0.Lampe']),
            'enum.rooms.kueche': enumObject('enum.rooms.kueche', ['a.0.Herd']),
        };
        const functions = {
            'enum.functions.licht': enumObject('enum.functions.licht', ['a.0.Lampe', 'a.0.NurFunktion']),
        };
        const objects: ObjectMap = {
            'a.0.Lampe': container('a.0.Lampe'),
            'a.0.NurFunktion': container('a.0.NurFunktion'),
        };
        const states = ['a.0.Lampe.on', 'a.0.Herd.on', 'a.0.NurFunktion.on', 'a.0.Nichts.on'];

        function notRead(config: Partial<DiscoveryConfig>): Record<string, string[]> {
            const found: Diagnostic[] = [];
            explainDiscovery(
                states,
                rooms,
                functions,
                objects,
                { selectedRooms: [], selectedFunctions: [], extraStatePrefixes: [], ...config },
                d => found.push(d),
            );
            return Object.fromEntries(found.map(d => (d.code === 'not-read' ? [d.stateId, d.reasons] : ['', []])));
        }

        it('without a selection, a state needs a room', () => {
            expect(notRead({})).to.deep.equal({
                'a.0.NurFunktion.on': ['no-room'],
                'a.0.Nichts.on': ['no-room'],
            });
        });

        it('with a function selection, a state needs a function and not a room', () => {
            expect(notRead({ selectedFunctions: ['enum.functions.licht'] })).to.deep.equal({
                'a.0.Herd.on': ['no-function'],
                'a.0.Nichts.on': ['no-function'],
            });
        });

        it('with both selected, the function member has to lie within a selected room', () => {
            expect(
                notRead({ selectedRooms: ['enum.rooms.kueche'], selectedFunctions: ['enum.functions.licht'] }),
            ).to.deep.equal({
                'a.0.Lampe.on': ['outside-selection'],
                'a.0.Herd.on': ['no-function'],
                'a.0.NurFunktion.on': ['no-room'],
                'a.0.Nichts.on': ['no-room', 'no-function'],
            });
        });

        it('with a room selection, a state in another room is outside the selection', () => {
            expect(notRead({ selectedRooms: ['enum.rooms.kueche'] })).to.deep.equal({
                'a.0.Lampe.on': ['outside-selection'],
                'a.0.NurFunktion.on': ['no-room'],
                'a.0.Nichts.on': ['no-room'],
            });
        });

        it('reads a state below an extra prefix in any case', () => {
            expect(notRead({ extraStatePrefixes: ['a.0.Nichts'] })).to.not.have.property('a.0.Nichts.on');
        });
    });

    describe('describeDiagnostic', () => {
        const all: Diagnostic[] = [
            { code: 'not-read', stateId: 'a.0.x.on', reasons: ['no-room', 'no-function'] },
            { code: 'not-read', stateId: 'a.0.x.on', reasons: ['outside-selection'] },
            { code: 'no-room', deviceId: 'a.0.x', stateIds: ['a.0.x.on'] },
            { code: 'no-recognized-slot', deviceId: 'a.0.x', stateIds: ['a.0.x.on'] },
            { code: 'state-generic', deviceId: 'a.0.x', stateId: 'a.0.x.foo', key: 'foo', role: '' },
            {
                code: 'slot-ambiguous',
                deviceId: 'a.0.x',
                slot: 'target_temperature',
                candidates: ['a.0.x.a', 'a.0.x.b'],
                remaining: ['a.0.x.a', 'a.0.x.b'],
            },
            { code: 'unit-mismatch', deviceId: 'a.0.x', stateId: 'a.0.x.p', slot: 'power', unit: 'mA' },
            { code: 'switch-implausible', stateId: 'a.0.x.led' },
            { code: 'merged', deviceId: 'a.0.x', groupIds: ['a.0.x.1', 'a.0.x.2'] },
            { code: 'merge-blocked', deviceId: 'a.0.x', groupIds: ['a.0.x.1', 'a.0.x.2'] },
        ];

        it('gives every finding a text, and a fix unless it only explains a decision', () => {
            for (const diagnostic of all) {
                const { text, fix } = describeDiagnostic(diagnostic);
                expect(text, diagnostic.code).to.match(/a\.0\.x/);
                if (severityOf(diagnostic) === 'warning') {
                    expect(fix, diagnostic.code).to.not.equal('');
                } else {
                    expect(fix, diagnostic.code).to.equal('');
                }
            }
        });

        it('names what is missing: a room, a function, or only the selection', () => {
            expect(describeDiagnostic(all[0]).fix).to.contain('a room and a function');
            expect(describeDiagnostic(all[1]).fix).to.not.contain('Assign');
        });

        it('takes the merges for information and everything that is not used for a warning', () => {
            expect(severityOf({ code: 'merged', deviceId: 'a', groupIds: [] })).to.equal('info');
            expect(severityOf({ code: 'merge-blocked', deviceId: 'a', groupIds: [] })).to.equal('info');
            expect(severityOf({ code: 'no-room', deviceId: 'a', stateIds: [] })).to.equal('warning');
        });
    });
});
