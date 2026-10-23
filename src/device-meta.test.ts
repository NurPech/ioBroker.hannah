import { expect } from 'chai';
import { aliasTargetId, resolveDeviceMeta, resolveNeededTrust, type ObjectMap } from './device-meta';

const options = { namespace: 'hannah.0', floorMappings: [] };

function stateObject(id: string, common: Record<string, unknown>): ioBroker.Object {
    return { _id: id, type: 'state', common: { name: '', ...common }, native: {} } as unknown as ioBroker.Object;
}

function enumObject(id: string, members: string[], name = id.split('.').pop()): ioBroker.Object {
    return { _id: id, type: 'enum', common: { name, members }, native: {} } as unknown as ioBroker.Object;
}

describe('device-meta', () => {
    describe('resolveDeviceMeta', () => {
        const stateId = 'javascript.0.virtualDevice.Test.Lamp.on';
        const deviceId = 'javascript.0.virtualDevice.Test.Lamp';

        it('resolves a state from plain objects, without an adapter', () => {
            const objects: ObjectMap = {
                [stateId]: stateObject(stateId, { role: 'switch.light', type: 'boolean', write: true }),
                [deviceId]: { _id: deviceId, type: 'device', common: { name: 'Lampe' }, native: {} },
            };
            const rooms = { 'enum.rooms.wohnzimmer': enumObject('enum.rooms.wohnzimmer', [deviceId], 'Wohnzimmer') };
            const functions = { 'enum.functions.licht': enumObject('enum.functions.licht', [deviceId]) };

            const { meta, warnings } = resolveDeviceMeta(stateId, objects, rooms, functions, options);

            expect(warnings).to.deep.equal([]);
            expect(meta).to.deep.include({
                room: 'wohnzimmer',
                device: 'Lampe',
                deviceId,
                type: 'light',
                canonicalKey: 'on',
                writable: true,
                functionIds: ['enum.functions.licht'],
            });
            expect(meta.roomNames).to.deep.equal({ de: 'Wohnzimmer' });
        });

        it('resolves a state whose objects are missing to empty meta data', () => {
            const { meta } = resolveDeviceMeta(stateId, {}, {}, {}, options);

            expect(meta).to.deep.include({ room: '', type: '', canonicalKey: '', writable: false, role: '' });
        });

        it('takes role and unit from the target of an alias', () => {
            const aliasId = 'alias.0.Wohnzimmer.Lampe.level';
            const targetId = 'hue.0.Lamp.bri';
            const objects: ObjectMap = {
                [aliasId]: stateObject(aliasId, { alias: { id: targetId }, write: true }),
                [targetId]: stateObject(targetId, {
                    role: 'level.dimmer',
                    type: 'number',
                    unit: '%',
                    min: 0,
                    max: 100,
                }),
            };

            const { meta } = resolveDeviceMeta(aliasId, objects, {}, {}, options);

            expect(meta).to.deep.include({ role: 'level.dimmer', canonicalKey: 'level', unit: '%', min: 0, max: 100 });
        });

        it('keeps its own scale for an alias that converts the value', () => {
            const aliasId = 'alias.0.Wohnzimmer.Lampe.level';
            const targetId = 'hue.0.Lamp.bri';
            const objects: ObjectMap = {
                [aliasId]: stateObject(aliasId, { alias: { id: targetId, read: 'val / 2.54' } }),
                [targetId]: stateObject(targetId, { role: 'level.dimmer', type: 'number', unit: 'raw', max: 254 }),
            };

            const { meta } = resolveDeviceMeta(aliasId, objects, {}, {}, options);

            expect(meta).to.deep.include({ role: 'level.dimmer', unit: '' });
            expect(meta.max).to.equal(undefined);
        });

        it('returns an invalid neededTrust as a warning instead of logging it', () => {
            const objects: ObjectMap = {
                [stateId]: stateObject(stateId, {
                    role: 'switch.light',
                    custom: { 'hannah.0': { enabled: true, neededTrust: 11 } },
                }),
            };

            const { meta, warnings } = resolveDeviceMeta(stateId, objects, {}, {}, options);

            expect(meta.requiredTrustLevel).to.equal(undefined);
            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.contain('neededTrust');
        });
    });

    describe('aliasTargetId', () => {
        it('knows the plain, read and write forms of an alias', () => {
            expect(aliasTargetId(stateObject('a.0.x', { alias: { id: 'b.0.y' } }))).to.equal('b.0.y');
            expect(aliasTargetId(stateObject('a.0.x', { alias: { id: { read: 'b.0.r', write: 'b.0.w' } } }))).to.equal(
                'b.0.r',
            );
            expect(aliasTargetId(stateObject('a.0.x', { alias: { id: { write: 'b.0.w' } } }))).to.equal('b.0.w');
        });

        it('is undefined for a state that is no alias', () => {
            expect(aliasTargetId(stateObject('a.0.x', {}))).to.equal(undefined);
            expect(aliasTargetId(undefined)).to.equal(undefined);
        });
    });

    describe('resolveNeededTrust', () => {
        it('reads a level from an enabled override only', () => {
            expect(resolveNeededTrust({ enabled: true, neededTrust: '7' }).level).to.equal(7);
            expect(resolveNeededTrust({ enabled: true, neededTrust: 0 }).level).to.equal(0);
            expect(resolveNeededTrust({ enabled: false, neededTrust: 7 }).level).to.equal(undefined);
            expect(resolveNeededTrust(undefined).level).to.equal(undefined);
        });
    });
});
