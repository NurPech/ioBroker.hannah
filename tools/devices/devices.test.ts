import { expect } from 'chai';
import { parseArguments, run } from './cli';
import { analyzeObjects } from './device-analysis';
import { formatReport } from './device-report';
import { parseObjectDump, parseStateDump } from './object-dump';

function stateObject(id: string, common: Record<string, unknown>): ioBroker.Object {
    return {
        _id: id,
        type: 'state',
        common: { name: id.split('.').pop(), write: true, ...common },
        native: {},
    } as ioBroker.Object;
}

function container(id: string): ioBroker.Object {
    return { _id: id, type: 'device', common: { name: id.split('.').pop() }, native: {} } as ioBroker.Object;
}

function enumObject(id: string, members: string[], name: unknown = id.split('.').pop()): ioBroker.Object {
    return { _id: id, type: 'enum', common: { name, members }, native: {} } as ioBroker.Object;
}

/** A lamp in a room and a function, a thermostat with two setpoints, a config channel, a lamp without room. */
function setup(): Record<string, ioBroker.Object> {
    const objects: Record<string, ioBroker.Object> = {};
    const add = (obj: ioBroker.Object): void => {
        objects[obj._id] = obj;
    };
    add(container('hm.0.Lampe'));
    add(stateObject('hm.0.Lampe.on', { role: 'switch.light', type: 'boolean' }));
    add(stateObject('hm.0.Lampe.level', { role: 'level.dimmer', type: 'number', unit: '%' }));
    add(container('hm.0.Heizung'));
    add(stateObject('hm.0.Heizung.soll1', { role: 'level.temperature', type: 'number', unit: '°C' }));
    add(stateObject('hm.0.Heizung.soll2', { role: 'level.temperature', type: 'number', unit: '°C' }));
    add(stateObject('hm.0.Heizung.on', { role: 'switch', type: 'boolean' }));
    add(container('hm.0.Flur'));
    add(stateObject('hm.0.Flur.foo', { type: 'boolean' }));
    add(container('hm.0.Ohne'));
    add(stateObject('hm.0.Ohne.on', { role: 'switch.light', type: 'boolean' }));
    add(enumObject('enum.rooms.wohnzimmer', ['hm.0.Lampe', 'hm.0.Heizung', 'hm.0.Flur'], { de: 'Wohnzimmer' }));
    add(enumObject('enum.functions.licht', ['hm.0.Lampe']));
    return objects;
}

describe('devices tool', () => {
    describe('parseObjectDump / parseStateDump', () => {
        const lamp = { _id: 'a.0.x', type: 'state', common: {}, native: {} };

        it('reads a map of ID to object', () => {
            expect(Object.keys(parseObjectDump(JSON.stringify({ 'a.0.x': lamp })))).to.deep.equal(['a.0.x']);
        });

        it('reads a list of objects', () => {
            expect(Object.keys(parseObjectDump(JSON.stringify([lamp])))).to.deep.equal(['a.0.x']);
        });

        it('reads the rows of an object view', () => {
            const dump = JSON.stringify({ rows: [{ id: 'a.0.x', value: { type: 'state', common: {} } }] });

            expect(parseObjectDump(dump)['a.0.x']).to.deep.include({ _id: 'a.0.x', type: 'state' });
        });

        it('reads objects.jsonl, one line per object', () => {
            const dump = [
                JSON.stringify({ id: 'a.0.x', value: { type: 'state', common: {} } }),
                '',
                JSON.stringify({ id: 'a.0.y', value: { type: 'channel', common: {} } }),
            ].join('\n');

            expect(Object.keys(parseObjectDump(dump))).to.deep.equal(['a.0.x', 'a.0.y']);
        });

        it('reads nothing from a file that holds no objects', () => {
            expect(parseObjectDump('')).to.deep.equal({});
            expect(parseObjectDump('{"foo": 1}')).to.deep.equal({});
        });

        it('takes the val of a state, or a plain value', () => {
            expect(parseStateDump(JSON.stringify({ 'a.0.x': { val: 5, ack: true }, 'a.0.y': 'text' }))).to.deep.equal({
                'a.0.x': 5,
                'a.0.y': 'text',
            });
            expect(parseStateDump(JSON.stringify({ id: 'a.0.x', value: { val: true } }))).to.deep.equal({
                'a.0.x': true,
            });
        });
    });

    describe('analyzeObjects', () => {
        it('reports the devices of a setup and explains what is left out', () => {
            const analysis = analyzeObjects(setup(), { 'hm.0.Lampe.on': true, 'hm.0.Lampe.level': 60 });

            expect(analysis.devices.map(d => d.deviceId).sort()).to.deep.equal(['hm.0.Heizung', 'hm.0.Lampe']);
            expect(analysis.counts).to.deep.equal({ states: 7, read: 6 });
            const codes = analysis.findings.map(d => d.code);
            expect(codes).to.include.members(['not-read', 'slot-ambiguous', 'no-recognized-slot']);
            const lamp = analysis.devices.find(d => d.deviceId === 'hm.0.Lampe');
            expect(lamp?.slots.find(s => s.slotId === 'brightness')?.value).to.deep.equal({ number: 60 });
            expect(analysis.rooms.wohnzimmer).to.equal('Wohnzimmer');
        });

        it('simulates a room and a function for every device', () => {
            const analysis = analyzeObjects(setup(), {}, { simulate: true });

            expect(analysis.devices.map(d => d.deviceId)).to.include('hm.0.Ohne');
            expect(analysis.findings.some(d => d.code === 'not-read' || d.code === 'no-room')).to.equal(false);
            expect(analysis.counts).to.deep.equal({ states: 7, read: 7 });
        });

        it('looks only at the states below a prefix', () => {
            const analysis = analyzeObjects(setup(), {}, { prefixes: ['hm.0.Lampe.'] });

            expect(analysis.counts.states).to.equal(2);
            expect(analysis.devices.map(d => d.deviceId)).to.deep.equal(['hm.0.Lampe']);
        });

        it('reads only the selected rooms like the adapter setting', () => {
            const objects = setup();
            objects['enum.rooms.kueche'] = enumObject('enum.rooms.kueche', ['hm.0.Ohne']);

            const analysis = analyzeObjects(objects, {}, { selectedRooms: ['enum.rooms.kueche'] });

            expect(analysis.devices.map(d => d.deviceId)).to.deep.equal(['hm.0.Ohne']);
        });

        it('ignores system states', () => {
            const objects = setup();
            objects['system.adapter.hm.0.alive'] = stateObject('system.adapter.hm.0.alive', { type: 'boolean' });

            expect(analyzeObjects(objects).counts.states).to.equal(7);
        });
    });

    describe('formatReport', () => {
        it('prints devices with their slots, the findings of a device and what is left out', () => {
            const report = formatReport(analyzeObjects(setup()));

            expect(report).to.match(/Wohnzimmer · Lampe: LIGHT \(hm\.0\.Lampe\)/);
            expect(report).to.match(/brightness\s+BRIGHTNESS\s+rw\s+hm\.0\.Lampe\.level \(level\.dimmer, %\)/);
            expect(report).to.contain('2 states fit the slot "target_temperature"');
            expect(report).to.contain('States the adapter does not read (1)');
            expect(report).to.contain('hm.0.Ohne.on is not read by Hannah: it is in no room.');
            expect(report).to.contain('Devices with no state Hannah knows (1)');
        });

        it('lists only a few of the states that are left out, unless asked for all', () => {
            const objects = setup();
            for (let i = 0; i < 30; i++) {
                objects[`x.0.s${i}`] = stateObject(`x.0.s${i}`, { type: 'boolean' });
            }
            const analysis = analyzeObjects(objects);

            expect(formatReport(analysis)).to.contain('... and 11 more (use --all to list them)');
            expect(formatReport(analysis, { all: true })).to.not.contain('more (use --all');
        });
    });

    describe('command line', () => {
        it('reads the options', () => {
            const args = parseArguments([
                'objects.json',
                '--states',
                'states.json',
                '--simulate',
                '--prefix',
                'hm.0.,zigbee.0.',
                '--rooms',
                'enum.rooms.a,enum.rooms.b',
                '--extra-prefix',
                'x.0.',
                '--all',
                '--json',
            ]);

            expect(args).to.deep.equal({
                objectsFile: 'objects.json',
                statesFile: 'states.json',
                json: true,
                all: true,
                analysis: {
                    simulate: true,
                    prefixes: ['hm.0.', 'zigbee.0.'],
                    selectedRooms: ['enum.rooms.a', 'enum.rooms.b'],
                    extraStatePrefixes: ['x.0.'],
                },
            });
        });

        it('says what is wrong with the arguments', () => {
            expect(parseArguments([])).to.equal('No objects file given');
            expect(parseArguments(['a.json', 'b.json'])).to.equal('Unknown argument b.json');
            expect(parseArguments(['a.json', '--bogus'])).to.equal('Unknown argument --bogus');
            expect(parseArguments(['a.json', '--states'])).to.equal('--states needs a value');
        });

        it('shows the usage on --help and exits with 2 on a wrong call', () => {
            expect(run(['--help'])).to.deep.include({ code: 0 });
            expect(run([])).to.deep.include({ code: 2 });
        });

        it('says so if the file cannot be read', () => {
            const { output, code } = run(['does-not-exist.json']);

            expect(code).to.equal(1);
            expect(output).to.contain('Cannot read the dump');
        });
    });
});
