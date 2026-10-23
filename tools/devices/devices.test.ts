import { expect } from 'chai';
import { adapterConfigOptions, parseArguments, run } from './cli';
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
    add(enumObject('enum.functions.heizung', ['hm.0.Heizung', 'hm.0.Flur']));
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
            expect(analysis.counts).to.deep.equal({ states: 7, read: 6, raw: 0 });
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
            expect(analysis.counts).to.deep.equal({ states: 7, read: 7, raw: 0 });
        });

        it('looks only at the states below a prefix', () => {
            const analysis = analyzeObjects(setup(), {}, { prefixes: ['hm.0.Lampe.'] });

            expect(analysis.counts.states).to.equal(2);
            expect(analysis.devices.map(d => d.deviceId)).to.deep.equal(['hm.0.Lampe']);
        });

        it('reads only the selected rooms like the adapter setting', () => {
            const objects = setup();
            objects['enum.rooms.kueche'] = enumObject('enum.rooms.kueche', ['hm.0.Ohne']);

            const analysis = analyzeObjects(
                objects,
                {},
                { selectedRooms: ['enum.rooms.kueche'], selectedFunctions: [] },
            );

            expect(analysis.devices.map(d => d.deviceId)).to.deep.equal(['hm.0.Ohne']);
        });

        it('says which function is not selected, and names the states', () => {
            const objects = setup();
            objects['hm.0.Pwa'] = container('hm.0.Pwa');
            objects['hm.0.Pwa.xy'] = stateObject('hm.0.Pwa.xy', { type: 'string' });
            objects['enum.rooms.pwaraum'] = enumObject('enum.rooms.pwaraum', ['hm.0.Pwa']);
            objects['enum.functions.pwa'] = enumObject('enum.functions.pwa', ['hm.0.Pwa']);

            const report = formatReport(
                analyzeObjects(objects, {}, { selectedFunctions: ['enum.functions.licht', 'enum.functions.heizung'] }),
            );

            expect(report).to.contain('it is only in the function pwa, which is not selected in the adapter settings');
            expect(report).to.contain('hm.0.Pwa: xy');
        });

        it('does not take devices under a folder for channels of one device', () => {
            const objects = setup();
            objects['hm.0.Raum'] = { ...container('hm.0.Raum'), type: 'folder' } as ioBroker.Object;
            for (const name of ['A', 'B']) {
                objects[`hm.0.Raum.${name}`] = container(`hm.0.Raum.${name}`);
                objects[`hm.0.Raum.${name}.on`] = stateObject(`hm.0.Raum.${name}.on`, {
                    role: 'switch.light',
                    type: 'boolean',
                });
            }
            objects['enum.rooms.raum'] = enumObject('enum.rooms.raum', ['hm.0.Raum']);
            objects['enum.functions.lampen'] = enumObject('enum.functions.lampen', ['hm.0.Raum']);

            const report = formatReport(analyzeObjects(objects), { all: true });

            expect(analyzeObjects(objects).devices.map(d => d.deviceId)).to.include.members([
                'hm.0.Raum.A',
                'hm.0.Raum.B',
            ]);
            expect(report).to.not.contain('stay devices of their own');
            expect(report).to.not.contain('(not reported)');
        });

        it('still explains channels of one device that stay apart', () => {
            const objects = setup();
            objects['hm.0.Steckdose'] = container('hm.0.Steckdose');
            for (const name of ['1', '2']) {
                objects[`hm.0.Steckdose.${name}`] = {
                    ...container(`hm.0.Steckdose.${name}`),
                    type: 'channel',
                } as ioBroker.Object;
                objects[`hm.0.Steckdose.${name}.on`] = stateObject(`hm.0.Steckdose.${name}.on`, {
                    role: 'switch.light',
                    type: 'boolean',
                });
            }
            objects['enum.rooms.steck'] = enumObject('enum.rooms.steck', ['hm.0.Steckdose']);
            objects['enum.functions.steck'] = enumObject('enum.functions.steck', ['hm.0.Steckdose']);

            const report = formatReport(analyzeObjects(objects), { all: true });

            expect(report).to.contain('In hm.0.Steckdose, 1, 2 stay devices of their own');
        });

        it('does not report a state read through an extra prefix as a device without a room', () => {
            const objects = setup();
            objects['car.0.Auto.position'] = container('car.0.Auto.position');
            objects['car.0.Auto.position.latitude'] = stateObject('car.0.Auto.position.latitude', { type: 'number' });

            const analysis = analyzeObjects(objects, {}, { extraStatePrefixes: ['car.0.Auto'] });

            expect(analysis.counts.raw).to.equal(1);
            expect(analysis.counts.read).to.equal(7);
            expect(JSON.stringify(analysis.findings)).to.not.contain('car.0.Auto');
            expect(formatReport(analysis)).to.contain('1 of them raw states through extra prefixes');
        });

        it('still reports a state with the prefix that is in a room and a function', () => {
            const objects = setup();
            objects['hm.0.Lampe.xy'] = stateObject('hm.0.Lampe.xy', { type: 'string' });

            const analysis = analyzeObjects(objects, {}, { extraStatePrefixes: ['hm.0.Lampe'] });

            expect(analysis.counts.raw).to.equal(0);
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
            expect(report).to.match(/brightness\s+BRIGHTNESS\s+rw\s+\.level \(level\.dimmer, %\)/);
            expect(report).to.contain('2 states fit the slot "target_temperature"');
            expect(report).to.contain('States the adapter does not read (1)');
            expect(report).to.contain('1 states in 1 objects: it is in no room and it is in no function');
            expect(report).to.contain('hm.0.Ohne: on');
            expect(report).to.contain('Devices with no state Hannah knows (1)');
        });

        it('lists only a few of the states that are left out, unless asked for all', () => {
            const objects = setup();
            for (let i = 0; i < 30; i++) {
                objects[`x.0.d${i}.s`] = stateObject(`x.0.d${i}.s`, { type: 'boolean' });
            }
            const analysis = analyzeObjects(objects);

            expect(formatReport(analysis)).to.contain('... and 11 more (use --all to list them)');
            expect(formatReport(analysis, { all: true })).to.not.contain('more (use --all');
        });
    });

    describe('formatReport on a dump', () => {
        it('tells a dump without room enums, instead of listing every state', () => {
            const objects = Object.fromEntries(Object.entries(setup()).filter(([id]) => !id.startsWith('enum.')));

            const report = formatReport(analyzeObjects(objects));

            expect(report).to.contain('Note: the dump has no room enums');
            expect(report).to.contain('7 states in 4 objects: it is in no room.');
            expect(formatReport(analyzeObjects(objects, {}, { simulate: true }))).to.not.contain('Note:');
        });

        it('shows a generic slot as one line, and explains it only with --all', () => {
            const objects = setup();
            objects['hm.0.Lampe.weird'] = stateObject('hm.0.Lampe.weird', { type: 'number' });
            const analysis = analyzeObjects(objects);

            expect(formatReport(analysis)).to.contain('+ 1 generic slots: weird');
            expect(formatReport(analysis)).to.not.contain('is only a generic slot');
            expect(formatReport(analysis, { all: true })).to.contain('is only a generic slot');
        });
    });

    describe('a selection that is not in the dump', () => {
        it('says so and names the IDs the dump has, instead of silently reading nothing', () => {
            const analysis = analyzeObjects(setup(), {}, { selectedFunctions: ['enum.functions.licht2'] });

            expect(analysis.unknownSelection).to.deep.equal(['enum.functions.licht2']);
            expect(analysis.counts.read).to.equal(0);
            const report = formatReport(analysis);
            expect(report).to.contain('Note: enum.functions.licht2 is not in the dump, so nothing matches.');
            expect(report).to.contain('Functions in the dump: enum.functions.heizung, enum.functions.licht');
            expect(report).to.not.contain('Rooms in the dump');
        });

        it('names the rooms if a room is the one that is missing', () => {
            const report = formatReport(analyzeObjects(setup(), {}, { selectedRooms: ['enum.rooms.keller'] }));

            expect(report).to.contain('Rooms in the dump: enum.rooms.wohnzimmer');
        });

        it('takes "all" for every function of the dump, so a state without a function is not read', () => {
            const analysis = analyzeObjects(setup(), {}, { selectedFunctions: ['all'] });

            expect(analysis.unknownSelection).to.deep.equal([]);
            expect(analysis.devices.map(d => d.deviceId).sort()).to.deep.equal(['hm.0.Heizung', 'hm.0.Lampe']);
            const notRead = analysis.findings.filter(d => d.code === 'not-read');
            expect(notRead.some(d => d.code === 'not-read' && d.reasons.includes('no-function'))).to.equal(true);
        });

        it('says nothing about a selection that exists', () => {
            const analysis = analyzeObjects(setup(), {}, { selectedFunctions: ['enum.functions.licht'] });

            expect(analysis.unknownSelection).to.deep.equal([]);
            expect(formatReport(analysis)).to.not.contain('Note:');
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
                configFile: undefined,
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

        it('reads the room and function selection and the extra prefixes from the adapter settings', () => {
            const settings = {
                selectedRooms: ['enum.rooms.kueche'],
                selectedFunctions: ['enum.functions.licht'],
                extraStatePrefixes: [{ prefix: 'javascript.0.virtualDevice.Auto' }, { prefix: '' }],
                hannahHost: '192.168.0.1',
            };
            const expected = {
                selectedRooms: ['enum.rooms.kueche'],
                selectedFunctions: ['enum.functions.licht'],
                extraStatePrefixes: ['javascript.0.virtualDevice.Auto'],
            };

            expect(adapterConfigOptions(settings)).to.deep.equal(expected);
            expect(adapterConfigOptions({ native: settings, common: {} })).to.deep.equal(expected);
            expect(adapterConfigOptions(undefined)).to.deep.equal({
                selectedRooms: [],
                selectedFunctions: [],
                extraStatePrefixes: [],
            });
        });

        it('applies the adapter settings to the analysis, and lets an option override them', () => {
            const fromSettings = adapterConfigOptions({ selectedFunctions: ['enum.functions.licht'] });
            const withSettings = analyzeObjects(setup(), {}, fromSettings);
            const overridden = analyzeObjects(setup(), {}, { ...fromSettings, selectedFunctions: [] });

            expect(withSettings.devices.map(d => d.deviceId)).to.deep.equal(['hm.0.Lampe']);
            expect(overridden.devices.length).to.be.greaterThan(1);
        });

        it('names the way to run it that exists', () => {
            const { output } = run(['--help']);

            expect(output).to.contain('npm run devices --');
            expect(output).to.not.contain('build/cli.js');
        });

        it('says so if the file cannot be read', () => {
            const { output, code } = run(['does-not-exist.json']);

            expect(code).to.equal(1);
            expect(output).to.contain('Cannot read the input');
        });
    });
});
