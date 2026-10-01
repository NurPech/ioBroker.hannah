import { expect } from 'chai';
import { v2 } from '@m1kad0/hannah-proto';
import {
    buildDeviceModel,
    fromSlotValue,
    slotKey,
    toSlotValue,
    type DeviceInput,
    type DeviceState,
    type SlotTarget,
} from './device-model';

import DeviceClass = v2.device_model.DeviceClass;
import DeviceSubtype = v2.device_model.DeviceSubtype;
import SlotKind = v2.device_model.SlotKind;

const BASE = 'javascript.0.virtualDevice.Test';

function state(suffix: string, over: Partial<DeviceState> = {}): DeviceState {
    return {
        stateId: `${BASE}.${suffix}`,
        suffix,
        key: suffix,
        value: null,
        valueType: 'number',
        writable: true,
        typeHint: '',
        inverted: false,
        requiredTrustLevel: undefined,
        options: [],
        ...over,
    };
}

function device(states: DeviceState[], over: Partial<DeviceInput> = {}): DeviceInput {
    return { deviceId: BASE, name: 'Test', room: 'wohnzimmer', floor: 'EG', states, ...over };
}

function classify(states: DeviceState[], over: Partial<DeviceInput> = {}): v2.device_model.TypedDevice {
    const [dev] = buildDeviceModel([device(states, over)]).devices;
    return dev;
}

function kindsOf(dev: v2.device_model.TypedDevice): Record<string, SlotKind> {
    return Object.fromEntries(dev.slots.map(s => [s.slotId, s.kind]));
}

describe('device-model', () => {
    describe('classes', () => {
        it('a light with brightness, color and color temperature carries all of them', () => {
            const dev = classify([
                state('on', { key: 'on', valueType: 'boolean', typeHint: 'light', value: true }),
                state('level', { key: 'level', typeHint: 'light', value: 60 }),
                state('color', { key: 'color', valueType: 'color', typeHint: 'light', value: '#00ff00' }),
                state('colortemp', { key: 'colorTemp', typeHint: 'light', value: 2700 }),
            ]);

            expect(dev.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_LIGHT);
            expect(kindsOf(dev)).to.deep.equal({
                on: SlotKind.SLOT_KIND_ON,
                brightness: SlotKind.SLOT_KIND_BRIGHTNESS,
                color: SlotKind.SLOT_KIND_COLOR,
                color_temperature: SlotKind.SLOT_KIND_COLOR_TEMPERATURE,
            });
            const color = dev.slots.find(s => s.slotId === 'color');
            expect(color?.value).to.deep.equal({ rgb: 0x00ff00 });
        });

        it('a light without brightness has no brightness slot', () => {
            const dev = classify([state('on', { key: 'on', valueType: 'boolean', typeHint: 'light', value: false })]);

            expect(dev.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_LIGHT);
            expect(kindsOf(dev)).to.deep.equal({ on: SlotKind.SLOT_KIND_ON });
        });

        it('a read-only brightness never makes a lamp of a button', () => {
            const dev = classify([
                state('on', { key: 'on', valueType: 'boolean', writable: false, value: true }),
                state('level', { key: 'level', writable: false, value: 50 }),
            ]);

            expect(dev.deviceClass).to.not.equal(DeviceClass.DEVICE_CLASS_LIGHT);
        });

        it('a socket is a socket by its type hint or by measuring power, a bare switch is a binary switch', () => {
            const hinted = classify([state('on', { key: 'on', valueType: 'boolean', typeHint: 'socket' })]);
            const measuring = classify([
                state('on', { key: 'on', valueType: 'boolean' }),
                state('power', { key: 'power', writable: false, value: 12.5 }),
            ]);
            const bare = classify([state('on', { key: 'on', valueType: 'boolean', typeHint: 'scene' })]);

            expect(hinted.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_SOCKET);
            expect(measuring.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_SOCKET);
            expect(bare.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_GENERIC_BINARY_SWITCH);
        });

        it('a thermostat needs a setpoint, a room temperature alone is a sensor', () => {
            const thermostat = classify([
                state('current', { key: 'current', writable: false, typeHint: 'thermostat', value: 21.4 }),
                state('expected', { key: 'expected', typeHint: 'thermostat', value: 19 }),
            ]);
            const sensor = classify([
                state('current', { key: 'current', writable: false, typeHint: 'temperature_sensor' }),
            ]);

            expect(thermostat.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_THERMOSTAT);
            expect(kindsOf(thermostat)).to.deep.equal({
                temperature: SlotKind.SLOT_KIND_TEMPERATURE,
                target_temperature: SlotKind.SLOT_KIND_TARGET_TEMPERATURE,
            });
            expect(sensor.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_SENSOR);
        });

        it('humidity and temperature of a sensor do not collide', () => {
            const humidity = classify([state('hum', { key: 'current', writable: false, typeHint: 'humidity_sensor' })]);

            expect(kindsOf(humidity)).to.deep.equal({ humidity: SlotKind.SLOT_KIND_HUMIDITY });
        });

        it('an air quality device with iaq, co2 and voc is a sensor', () => {
            const dev = classify([
                state('iaq', { key: 'iaq', writable: false, value: 92 }),
                state('co2_equiv', { key: 'co2_equiv', writable: false, value: 911 }),
                state('voc_equiv', { key: 'voc_equiv', writable: false, value: 1.2 }),
            ]);

            expect(dev.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_SENSOR);
            expect(kindsOf(dev)).to.deep.equal({
                iaq: SlotKind.SLOT_KIND_IAQ,
                co2: SlotKind.SLOT_KIND_CO2,
                voc: SlotKind.SLOT_KIND_VOC,
            });
        });

        it('a window and a door contact are told apart by their type hint', () => {
            const window = classify([
                state('open', { key: 'open', valueType: 'boolean', writable: false, typeHint: 'window' }),
            ]);
            const door = classify([
                state('open', { key: 'open', valueType: 'boolean', writable: false, typeHint: 'door' }),
            ]);
            const plain = classify([state('open', { key: 'open', valueType: 'boolean', writable: false })]);

            expect(window.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_CONTACT);
            expect(window.subtype).to.equal(DeviceSubtype.DEVICE_SUBTYPE_WINDOW);
            expect(door.subtype).to.equal(DeviceSubtype.DEVICE_SUBTYPE_DOOR);
            expect(plain.subtype).to.equal(DeviceSubtype.DEVICE_SUBTYPE_UNSPECIFIED);
        });

        it('a blind is a cover with a position, an inverted actuator is reported in the 100 = open scale', () => {
            const dev = classify([state('level', { key: 'level', typeHint: 'blind', inverted: true, value: 30 })]);

            expect(dev.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_COVER);
            const position = dev.slots[0];
            expect(position.kind).to.equal(SlotKind.SLOT_KIND_POSITION);
            expect(position.value).to.deep.equal({ number: 70 });
        });

        it('an air conditioner is a climate device with mode and fan speed options', () => {
            const dev = classify([
                state('on', { key: 'on', valueType: 'boolean', typeHint: 'climate', value: true }),
                state('mode', {
                    key: 'mode',
                    valueType: 'enum',
                    typeHint: 'climate',
                    options: ['heat', 'cool'],
                    value: 'cool',
                }),
                state('fanSpeed', {
                    key: 'fanSpeed',
                    valueType: 'enum',
                    typeHint: 'climate',
                    options: ['auto', 'low'],
                    value: 'auto',
                }),
                state('expected', { key: 'expected', typeHint: 'climate', value: 22 }),
            ]);

            expect(dev.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_CLIMATE);
            const mode = dev.slots.find(s => s.kind === SlotKind.SLOT_KIND_MODE);
            expect(mode?.options).to.deep.equal(['cool', 'heat']);
            expect(mode?.value).to.deep.equal({ text: 'cool' });
            expect(dev.slots.find(s => s.kind === SlotKind.SLOT_KIND_FAN_SPEED)?.options).to.deep.equal([
                'auto',
                'low',
            ]);
        });
    });

    describe('picking', () => {
        it('a setpoint wins over comfort and eco setpoints', () => {
            const dev = classify([
                state('expected', { key: 'expected', value: 19 }),
                state('comfortExpected', { key: 'expected', value: 21 }),
                state('ecoExpected', { key: 'expected', value: 17 }),
            ]);

            const target = dev.slots.find(s => s.kind === SlotKind.SLOT_KIND_TARGET_TEMPERATURE);
            expect(target?.slotId).to.equal('target_temperature');
            expect(target?.value).to.deep.equal({ number: 19 });
            expect(dev.slots).to.have.length(3);
        });

        it('with no clear winner nothing is picked and every state stays a generic slot', () => {
            const dev = classify([
                state('target1', { key: 'expected', value: 19 }),
                state('target2', { key: 'expected', value: 21 }),
            ]);

            expect(dev.slots.map(s => s.kind)).to.deep.equal([
                SlotKind.SLOT_KIND_GENERIC_NUMBER,
                SlotKind.SLOT_KIND_GENERIC_NUMBER,
            ]);
            expect(dev.deviceClass).to.equal(DeviceClass.DEVICE_CLASS_GENERIC);
        });

        it('a colour and a colour temperature do not collide', () => {
            const dev = classify([
                state('on', { key: 'on', valueType: 'boolean', typeHint: 'light' }),
                state('rgb', {
                    key: slotKey({
                        canonicalKeyOverride: '',
                        role: 'level.color.rgb',
                        canonicalKey: 'color',
                        suffix: 'rgb',
                    }),
                    valueType: 'color',
                    typeHint: 'light',
                }),
                state('ct', {
                    key: slotKey({
                        canonicalKeyOverride: '',
                        role: 'level.color.temperature',
                        canonicalKey: 'color',
                        suffix: 'ct',
                    }),
                    typeHint: 'light',
                }),
            ]);

            expect(kindsOf(dev)).to.include({
                color: SlotKind.SLOT_KIND_COLOR,
                color_temperature: SlotKind.SLOT_KIND_COLOR_TEMPERATURE,
            });
        });
    });

    describe('slotKey', () => {
        const base = { canonicalKeyOverride: '', role: '', canonicalKey: '', suffix: 'foo' };

        it('an override beats everything', () => {
            expect(slotKey({ ...base, canonicalKeyOverride: 'level', role: 'level.color.rgb' })).to.equal('level');
        });

        it('tells colour, colour temperature and the rest of the colour roles apart', () => {
            expect(slotKey({ ...base, role: 'level.color.rgb', canonicalKey: 'color' })).to.equal('color');
            expect(slotKey({ ...base, role: 'level.color', canonicalKey: 'color' })).to.equal('color');
            expect(slotKey({ ...base, role: 'level.color.temperature', canonicalKey: 'color' })).to.equal('colorTemp');
            expect(slotKey({ ...base, role: 'level.color.hue', canonicalKey: 'color' })).to.equal('foo');
        });

        it('falls back from the resolved key to the state name, with spelling variants', () => {
            expect(slotKey({ ...base, canonicalKey: 'on' })).to.equal('on');
            expect(slotKey({ ...base, suffix: 'colortemp' })).to.equal('colorTemp');
            expect(slotKey(base)).to.equal('foo');
        });
    });

    describe('devices and slot index', () => {
        it('a device without room is not reported', () => {
            const model = buildDeviceModel([device([state('on', { key: 'on', valueType: 'boolean' })], { room: '' })]);

            expect(model.devices).to.deep.equal([]);
        });

        it('keeps name, room, floor and the trust level of a slot', () => {
            const dev = classify([state('on', { key: 'on', valueType: 'boolean', requiredTrustLevel: 8 })], {
                name: 'Haustür',
                room: 'flur',
                floor: 'EG',
            });

            expect(dev).to.include({ name: 'Haustür', room: 'flur', floor: 'EG', available: true });
            expect(dev.slots[0].requiredTrustLevel).to.equal(8);
        });

        it('names the state behind a slot as its identifier, for generic slots too', () => {
            const dev = classify([
                state('on', { key: 'on', valueType: 'boolean' }),
                state('weird', { key: 'weird', valueType: 'number' }),
            ]);

            expect(dev.slots.map(s => [s.slotId, s.identifier])).to.deep.equal([
                ['on', `${BASE}.on`],
                ['weird', `${BASE}.weird`],
            ]);
        });

        it('finds the slot of a state for live updates and the state of a slot for SetSlot', () => {
            const model = buildDeviceModel([device([state('on', { key: 'on', valueType: 'boolean' })])]);

            expect(model.bySlotState.get(`${BASE}.on`)).to.deep.include({ deviceId: BASE, slotId: 'on' });
            expect(model.targets.get(BASE)?.get('on')?.stateId).to.equal(`${BASE}.on`);
        });

        it('gives generic states their own slot IDs, also when the name is taken', () => {
            const dev = classify([
                state('on', { key: 'on', valueType: 'boolean', typeHint: 'socket' }),
                state('on_2', { key: 'foo', valueType: 'boolean' }),
                state('misc', { key: 'misc', valueType: 'text' }),
            ]);

            expect(dev.slots.map(s => s.slotId)).to.deep.equal(['on', 'on_2', 'misc']);
            expect(dev.slots[2].kind).to.equal(SlotKind.SLOT_KIND_GENERIC_TEXT);
            expect(dev.slots[2].label).to.equal('misc');
        });
    });

    describe('values', () => {
        it('turns ioBroker values into the scale of a slot kind', () => {
            expect(toSlotValue(SlotKind.SLOT_KIND_ON, 'true')).to.deep.equal({ boolean: true });
            expect(toSlotValue(SlotKind.SLOT_KIND_ON, 0)).to.deep.equal({ boolean: false });
            expect(toSlotValue(SlotKind.SLOT_KIND_BRIGHTNESS, '60')).to.deep.equal({ number: 60 });
            expect(toSlotValue(SlotKind.SLOT_KIND_COLOR, '#0096FF')).to.deep.equal({ rgb: 0x0096ff });
            expect(toSlotValue(SlotKind.SLOT_KIND_COLOR, 255)).to.deep.equal({ rgb: 255 });
            expect(toSlotValue(SlotKind.SLOT_KIND_MODE, 'cool')).to.deep.equal({ text: 'cool' });
        });

        it('knows no value for null, empty and unreadable ones', () => {
            expect(toSlotValue(SlotKind.SLOT_KIND_ON, null)).to.equal(undefined);
            expect(toSlotValue(SlotKind.SLOT_KIND_BRIGHTNESS, '')).to.equal(undefined);
            expect(toSlotValue(SlotKind.SLOT_KIND_BRIGHTNESS, 'hell')).to.equal(undefined);
            expect(toSlotValue(SlotKind.SLOT_KIND_COLOR, 'rot')).to.equal(undefined);
        });

        it('inverts the position of an inverted cover', () => {
            expect(toSlotValue(SlotKind.SLOT_KIND_POSITION, 30, true)).to.deep.equal({ number: 70 });
            expect(toSlotValue(SlotKind.SLOT_KIND_BRIGHTNESS, 30, true)).to.deep.equal({ number: 30 });
        });

        const target = (kind: SlotKind, over: Partial<SlotTarget> = {}): SlotTarget => ({
            stateId: `${BASE}.x`,
            kind,
            inverted: false,
            writable: true,
            valueType: 'number',
            requiredTrustLevel: undefined,
            ...over,
        });

        it('turns a SetSlot value back into what the state takes', () => {
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_ON), { boolean: true }, false)).to.equal(true);
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_BRIGHTNESS), { number: 40 }, 10)).to.equal(40);
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_MODE), { text: 'heat' }, 'cool')).to.equal('heat');
        });

        it('writes a colour in the notation the state already has', () => {
            const color = target(SlotKind.SLOT_KIND_COLOR, { valueType: 'color' });

            expect(fromSlotValue(color, { rgb: 0x0096ff }, '#000000')).to.equal('#0096ff');
            expect(fromSlotValue(color, { rgb: 0x0096ff }, 255)).to.equal(0x0096ff);
            expect(fromSlotValue(color, { rgb: 0x0000ff }, null)).to.equal('#0000ff');
        });

        it('inverts the position of an inverted cover again on writing', () => {
            const cover = target(SlotKind.SLOT_KIND_POSITION, { inverted: true });

            expect(fromSlotValue(cover, { number: 70 }, 0)).to.equal(30);
        });

        it('refuses a value that does not fit the kind', () => {
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_BRIGHTNESS), { boolean: true }, 0)).to.equal(undefined);
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_ON), { number: 1 }, false)).to.equal(undefined);
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_COLOR), { text: 'rot' }, '#000000')).to.equal(undefined);
            expect(fromSlotValue(target(SlotKind.SLOT_KIND_ON), undefined, false)).to.equal(undefined);
        });
    });
});
