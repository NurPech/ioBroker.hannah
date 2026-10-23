import type * as utils from '@iobroker/adapter-core';
import { expect } from 'chai';
import { collapseRoots, loadObjects, runDiagnostics } from './diagnostics-service';

function state(id: string, common: Record<string, unknown>): ioBroker.Object {
    return { _id: id, type: 'state', common: { name: '', write: true, ...common }, native: {} } as ioBroker.Object;
}

function folder(id: string, type: string): ioBroker.Object {
    return { _id: id, type, common: { name: id.split('.').pop() }, native: {} } as unknown as ioBroker.Object;
}

function enumObject(id: string, members: string[], name: unknown = id.split('.').pop()): ioBroker.Object {
    return { _id: id, type: 'enum', common: { name, members }, native: {} } as ioBroker.Object;
}

/**
 * An adapter that serves the objects of a map, like the parts of ioBroker the diagnostics use.
 *
 * @param objects - The objects of the setup by ID
 */
function adapterWith(objects: Record<string, ioBroker.Object>): utils.AdapterInstance {
    const matches = (pattern: string): string[] => {
        const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return Object.keys(objects).filter(id => regex.test(id));
    };
    return {
        namespace: 'hannah.0',
        getObjectViewAsync: (_design: string, _search: string, params: { startkey: string; endkey: string }) =>
            Promise.resolve({
                rows: Object.keys(objects)
                    .filter(id => id >= params.startkey && id <= params.endkey)
                    .sort()
                    .map(id => ({ id, value: objects[id] })),
            }),
        getForeignObjectAsync: (id: string) =>
            id.endsWith('.') || id.includes('..')
                ? Promise.reject(new Error(`The id "${id}" is invalid`))
                : Promise.resolve(objects[id] ?? null),
        getForeignObjectsAsync: (pattern: string) =>
            Promise.resolve(Object.fromEntries(matches(pattern).map(id => [id, objects[id]]))),
    } as unknown as utils.AdapterInstance;
}

describe('diagnostics-service', () => {
    function setup(): Record<string, ioBroker.Object> {
        const objects: Record<string, ioBroker.Object> = {};
        const add = (obj: ioBroker.Object): void => {
            objects[obj._id] = obj;
        };
        add(folder('hm.0.Licht', 'folder'));
        add(folder('hm.0.Licht.Lampe', 'device'));
        add(state('hm.0.Licht.Lampe.on', { role: 'switch.light', type: 'boolean' }));
        add(state('hm.0.Licht.Lampe.level', { role: 'level.dimmer', type: 'number', unit: '%' }));
        add(state('hm.0.Licht.Lampe.transition', { type: 'number' }));
        add(folder('hm.0.Licht.Ohne', 'device'));
        add(state('hm.0.Licht.Ohne.on', { role: 'switch.light', type: 'boolean' }));
        add(enumObject('enum.rooms.wohnzimmer', ['hm.0.Licht.Lampe', 'hm.0.Licht.Ohne'], { de: 'Wohnzimmer' }));
        add(enumObject('enum.functions.licht', ['hm.0.Licht.Lampe.on', 'hm.0.Licht.Lampe.level']));
        return objects;
    }

    describe('collapseRoots', () => {
        it('drops an ID that lies below another one, and doubles', () => {
            expect(collapseRoots(['a.0.x.y', 'a.0.x', 'a.0.z', 'a.0.x', 'a.0.xy'])).to.deep.equal([
                'a.0.x',
                'a.0.xy',
                'a.0.z',
            ]);
        });
    });

    describe('loadObjects', () => {
        it('loads the enums, everything below their members and the objects above', async () => {
            const { objects } = await loadObjects(adapterWith(setup()), []);

            expect(Object.keys(objects)).to.include.members([
                'enum.rooms.wohnzimmer',
                'enum.functions.licht',
                'hm.0.Licht.Lampe',
                'hm.0.Licht.Lampe.on',
                'hm.0.Licht.Ohne.on',
                'hm.0.Licht',
            ]);
        });

        it('also loads below a prefix that is no member of an enum', async () => {
            const all = setup();
            all['car.0.Auto.speed'] = state('car.0.Auto.speed', { type: 'number' });

            const { objects } = await loadObjects(adapterWith(all), ['car.0.Auto']);

            expect(objects['car.0.Auto.speed']).to.not.equal(undefined);
        });
    });

    describe('an ID that ioBroker refuses', () => {
        it('is read without its trailing dot', async () => {
            const all = setup();
            all['enum.rooms.wohnzimmer'] = enumObject('enum.rooms.wohnzimmer', ['hm.0.Licht.Lampe.']);

            const { objects, skipped } = await loadObjects(adapterWith(all), []);

            expect(skipped).to.deep.equal([]);
            expect(objects['hm.0.Licht.Lampe.on']).to.not.equal(undefined);
        });

        it('names an enum member that does not exist, with the enum that lists it', async () => {
            const all = setup();
            all['enum.rooms.wohnzimmer'] = enumObject('enum.rooms.wohnzimmer', ['hm.0.Licht.Lampe', 'old.0.gone.']);

            const result = await runDiagnostics(adapterWith(all), {});

            expect(result.devices.map(d => d.id)).to.deep.equal(['hm.0.Licht.Lampe']);
            expect(result.notes).to.deep.equal([
                'Member of an enum that does not exist in ioBroker: old.0.gone (in enum.rooms.wohnzimmer)',
            ]);
        });

        it('is skipped and named, and the rest is still analyzed', async () => {
            const all = setup();
            all['enum.rooms.wohnzimmer'] = enumObject('enum.rooms.wohnzimmer', ['hm.0.Licht.Lampe', 'hm.0..kaputt']);

            const result = await runDiagnostics(adapterWith(all), {});

            expect(result.devices.map(d => d.id)).to.deep.equal(['hm.0.Licht.Lampe']);
            expect(result.notes).to.deep.equal(['Not loaded: hm.0..kaputt: The id "hm.0..kaputt" is invalid']);
        });
    });

    describe('runDiagnostics', () => {
        it('tells the devices Hannah gets, with their slots and findings, and what is not read', async () => {
            const result = await runDiagnostics(adapterWith(setup()), {
                selectedRooms: ['enum.rooms.wohnzimmer'],
                selectedFunctions: ['enum.functions.licht'],
            });

            expect(result.devices.map(d => d.id)).to.deep.equal(['hm.0.Licht.Lampe']);
            const [lamp] = result.devices;
            expect(lamp).to.deep.include({ name: 'Lampe', room: 'Wohnzimmer', deviceClass: 'LIGHT' });
            expect(lamp.slots.map(s => s.id).sort()).to.deep.equal(['brightness', 'on']);
            expect(lamp.slots.find(s => s.id === 'brightness')).to.deep.include({
                stateId: 'hm.0.Licht.Lampe.level',
                role: 'level.dimmer',
                unit: '%',
                writable: true,
            });
            // transition has no function, so it is not read at all: no generic slot, but a state that is not read
            expect(lamp.genericSlots).to.deep.equal([]);
            const notRead = result.notRead.flatMap(g => g.objects.flatMap(o => o.states.map(s => `${o.id}.${s}`)));
            expect(notRead).to.include.members(['hm.0.Licht.Ohne.on', 'hm.0.Licht.Lampe.transition']);
            expect(result.counts.states).to.equal(4);
        });

        it('uses the settings of the request: with no selection every state below a room is read', async () => {
            const result = await runDiagnostics(adapterWith(setup()), {});

            expect(result.devices.map(d => d.id).sort()).to.deep.equal(['hm.0.Licht.Lampe', 'hm.0.Licht.Ohne']);
        });

        it('names a room or function that is selected but not in ioBroker', async () => {
            const result = await runDiagnostics(adapterWith(setup()), { selectedRooms: ['enum.rooms.keller'] });

            expect(result.notes).to.deep.equal(['Selected but not in ioBroker: enum.rooms.keller']);
        });

        it('leaves out what only explains a decision', async () => {
            const result = await runDiagnostics(adapterWith(setup()), {});

            expect(result.other.every(f => f.severity === 'warning')).to.equal(true);
        });
    });
});
