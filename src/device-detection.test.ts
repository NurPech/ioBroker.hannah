import { expect } from 'chai';
import { DeviceDetector } from './device-detection';

type Common = Record<string, unknown>;

function state(id: string, role: string, type: string, common: Common = {}): [string, ioBroker.Object] {
    return [
        id,
        {
            _id: id,
            type: 'state',
            common: { name: id.split('.').pop(), role, type, read: true, write: true, ...common },
            native: {},
        } as unknown as ioBroker.Object,
    ];
}

function channel(id: string, role = ''): [string, ioBroker.Object] {
    return [
        id,
        { _id: id, type: 'channel', common: { name: id.split('.').pop(), role }, native: {} } as ioBroker.Object,
    ];
}

function objects(...entries: Array<[string, ioBroker.Object]>): Record<string, ioBroker.Object> {
    return Object.fromEntries(entries);
}

const keysOf = (found: Map<string, { key: string; typeHint: string }>): Record<string, string> =>
    Object.fromEntries([...found].map(([id, d]) => [id.split('.').slice(-1)[0], d.key]));

describe('device-detection', () => {
    it('a dimmer: the level is the brightness, the switch is on, power is power', () => {
        const detector = new DeviceDetector(
            objects(
                channel('hm-rpc.0.DIM.1', 'light.dimmer'),
                state('hm-rpc.0.DIM.1.LEVEL', 'level.dimmer', 'number', { min: 0, max: 1 }),
                state('hm-rpc.0.DIM.1.ON', 'switch.light', 'boolean'),
                state('hm-rpc.0.DIM.1.POWER', 'value.power', 'number', { write: false, unit: 'W' }),
            ),
        );

        const found = detector.detect('hm-rpc.0.DIM.1');

        expect(keysOf(found)).to.deep.equal({ LEVEL: 'level', ON: 'on', POWER: 'power' });
        expect([...found.values()].every(d => d.typeHint === 'light')).to.equal(true);
    });

    it('a thermostat: setpoint, actual temperature and humidity do not collide', () => {
        const detector = new DeviceDetector(
            objects(
                channel('hm-rpc.0.THERM.1', 'thermostat'),
                state('hm-rpc.0.THERM.1.SET_TEMPERATURE', 'level.temperature', 'number', { unit: '°C' }),
                state('hm-rpc.0.THERM.1.ACTUAL_TEMPERATURE', 'value.temperature', 'number', { write: false }),
                state('hm-rpc.0.THERM.1.ACTUAL_HUMIDITY', 'value.humidity', 'number', { write: false }),
            ),
        );

        expect(keysOf(detector.detect('hm-rpc.0.THERM.1'))).to.deep.equal({
            SET_TEMPERATURE: 'expected',
            ACTUAL_TEMPERATURE: 'temperature',
            ACTUAL_HUMIDITY: 'humidity',
        });
    });

    it('a multi-relay plug: every relay channel is a socket of its own', () => {
        const detector = new DeviceDetector(
            objects(
                channel('shelly.0.plug.Relay0', 'switch'),
                state('shelly.0.plug.Relay0.Switch', 'switch', 'boolean'),
                state('shelly.0.plug.Relay0.Power', 'value.power', 'number', { write: false, unit: 'W' }),
                channel('shelly.0.plug.Relay1', 'switch'),
                state('shelly.0.plug.Relay1.Switch', 'switch', 'boolean'),
                state('shelly.0.plug.Relay1.Power', 'value.power', 'number', { write: false, unit: 'W' }),
            ),
        );

        const first = detector.detect('shelly.0.plug.Relay0');
        const second = detector.detect('shelly.0.plug.Relay1');

        expect([...first.keys()].every(id => id.includes('Relay0'))).to.equal(true);
        expect([...second.keys()].every(id => id.includes('Relay1'))).to.equal(true);
        expect(keysOf(first)).to.deep.equal({ Switch: 'on', Power: 'power' });
        expect(keysOf(second)).to.deep.equal({ Switch: 'on', Power: 'power' });
        expect(first.get('shelly.0.plug.Relay0.Switch')?.typeHint).to.equal('socket');
    });

    it('blinds: level and actual value are the position, stop is stop', () => {
        const detector = new DeviceDetector(
            objects(
                channel('hm-rpc.0.BLIND.1', 'blind'),
                state('hm-rpc.0.BLIND.1.LEVEL', 'level.blind', 'number'),
                state('hm-rpc.0.BLIND.1.STOP', 'button.stop', 'boolean'),
            ),
        );

        const found = detector.detect('hm-rpc.0.BLIND.1');

        expect(keysOf(found)).to.deep.equal({ LEVEL: 'level', STOP: 'stop' });
        expect(found.get('hm-rpc.0.BLIND.1.LEVEL')?.typeHint).to.equal('blind');
    });

    it('a window contact is open, with the window as type hint', () => {
        const detector = new DeviceDetector(
            objects(
                channel('hm-rpc.0.WIN.1', 'sensor.window'),
                state('hm-rpc.0.WIN.1.STATE', 'sensor.window', 'boolean', { write: false }),
            ),
        );

        const found = detector.detect('hm-rpc.0.WIN.1');

        expect(found.get('hm-rpc.0.WIN.1.STATE')).to.deep.equal({ key: 'open', typeHint: 'window' });
    });

    it('an air conditioner: mode and fan speed are slots, the type hint is climate', () => {
        const detector = new DeviceDetector(
            objects(
                channel('mqtt.0.ac', 'airconditioner'),
                state('mqtt.0.ac.mode', 'level.mode.airconditioner', 'number'),
                state('mqtt.0.ac.fan', 'level.mode.fan', 'number'),
                state('mqtt.0.ac.power', 'switch.power', 'boolean'),
                state('mqtt.0.ac.target', 'level.temperature', 'number'),
            ),
        );

        const found = detector.detect('mqtt.0.ac');

        expect(keysOf(found)).to.include({ mode: 'mode', fan: 'fanSpeed', power: 'on', target: 'expected' });
        expect([...found.values()][0].typeHint).to.equal('climate');
    });

    it('an air quality sensor: index, CO2 and TVOC', () => {
        const detector = new DeviceDetector(
            objects(
                channel('zigbee.0.aq'),
                state('zigbee.0.aq.aqi', 'value.airquality', 'number', { write: false }),
                state('zigbee.0.aq.co2', 'value.co2', 'number', { write: false }),
                state('zigbee.0.aq.tvoc', 'value.tvoc', 'number', { write: false }),
            ),
        );

        expect(keysOf(detector.detect('zigbee.0.aq'))).to.deep.equal({
            aqi: 'iaq',
            co2: 'co2_equiv',
            tvoc: 'voc_equiv',
        });
    });

    it('a temperature sensor with humidity: both get their own key', () => {
        const detector = new DeviceDetector(
            objects(
                channel('zigbee.0.th'),
                state('zigbee.0.th.temperature', 'value.temperature', 'number', { write: false }),
                state('zigbee.0.th.humidity', 'value.humidity', 'number', { write: false }),
            ),
        );

        expect(keysOf(detector.detect('zigbee.0.th'))).to.deep.equal({
            temperature: 'temperature',
            humidity: 'humidity',
        });
    });

    it('a flat alias folder is detected like any other channel', () => {
        const detector = new DeviceDetector(
            objects(
                state('alias.0.Licht.on', 'switch.light', 'boolean'),
                state('alias.0.Licht.level', 'level.dimmer', 'number'),
            ),
        );

        expect(keysOf(detector.detect('alias.0.Licht'))).to.deep.equal({ on: 'on', level: 'level' });
    });

    it('recognizes nothing in a group without roles, and does not throw', () => {
        const detector = new DeviceDetector(
            objects(channel('foo.0.x'), state('foo.0.x.a', '', 'number'), state('foo.0.x.b', '', 'string')),
        );

        expect(detector.detect('foo.0.x').size).to.equal(0);
        expect(detector.detect('does.not.exist').size).to.equal(0);
    });
});
