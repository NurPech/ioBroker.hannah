import { expect } from 'chai';
import { resolveDeviceMeta, type ObjectMap } from './device-meta';
import { buildTypedDevices, mergeDeviceIds, type CollectedState } from './device-snapshot';

function stateObject(id: string, common: Record<string, unknown>): ioBroker.Object {
    return { _id: id, type: 'state', common: { name: '', write: true, ...common }, native: {} } as ioBroker.Object;
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

describe('device-snapshot', () => {
    const device = 'javascript.0.virtualDevice.Test.Lamp';

    it('builds a typed device from plain objects, without an adapter', () => {
        const objects: ObjectMap = {
            [`${device}.on`]: stateObject(`${device}.on`, { role: 'switch.light', type: 'boolean' }),
            [`${device}.level`]: stateObject(`${device}.level`, { role: 'level.dimmer', type: 'number' }),
            [device]: { _id: device, type: 'device', common: { name: 'Lampe' }, native: {} },
        };
        const enums = {
            'enum.rooms.wohnzimmer': enumObject('enum.rooms.wohnzimmer', [device]),
            'enum.functions.licht': enumObject('enum.functions.licht', [device]),
        };
        const collected = collect({ [`${device}.on`]: true, [`${device}.level`]: 60 }, objects, enums);

        const { model, merges } = buildTypedDevices(collected, {}, enums);

        expect(merges).to.deep.equal([]);
        expect(model.devices).to.have.length(1);
        const [dev] = model.devices;
        expect(dev).to.include({ deviceId: device, name: 'Lampe', room: 'wohnzimmer' });
        expect(dev.slots.map(s => s.slotId).sort()).to.deep.equal(['brightness', 'on']);
    });

    it('does not report a device without room', () => {
        const objects: ObjectMap = {
            [`${device}.on`]: stateObject(`${device}.on`, { role: 'switch.light', type: 'boolean' }),
        };
        const collected = collect({ [`${device}.on`]: true }, objects, {});

        const { model } = buildTypedDevices(collected, {}, {});

        expect(model.devices).to.deep.equal([]);
    });

    it('names a merged device after the device object it is given', () => {
        const dev = 'dev.0.Kueche';
        const objects: ObjectMap = {
            [`${dev}.1.on`]: stateObject(`${dev}.1.on`, { role: 'switch.light', type: 'boolean' }),
            [`${dev}.2.level`]: stateObject(`${dev}.2.level`, { role: 'level.dimmer', type: 'number' }),
        };
        const enums = {
            'enum.rooms.kueche': enumObject('enum.rooms.kueche', [dev]),
            'enum.functions.licht': enumObject('enum.functions.licht', [dev]),
        };
        const collected = collect({ [`${dev}.1.on`]: true, [`${dev}.2.level`]: 40 }, objects, enums);
        const named: ObjectMap = {
            [dev]: { _id: dev, type: 'device', common: { name: 'Küchenlampe' }, native: {} },
        };

        const { model, merges } = buildTypedDevices(collected, named, enums);

        expect(merges).to.deep.equal([{ deviceId: dev, groupIds: [`${dev}.1`, `${dev}.2`] }]);
        expect(model.devices).to.have.length(1);
        expect(model.devices[0]).to.include({ deviceId: dev, name: 'Küchenlampe' });
    });

    it('lists the device objects that a merged device may be named after', () => {
        const ids = mergeDeviceIds([
            { id: 'dev.0.Kueche.1.on' },
            { id: 'dev.0.Kueche.2.level' },
            { id: 'alias.0.Lampe.on' },
            { id: 'alias.0.Flag' },
        ]);

        expect(ids.sort()).to.deep.equal(['dev.0.Kueche']);
    });
});
