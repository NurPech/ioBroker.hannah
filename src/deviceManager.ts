import {
    DeviceManagement,
    type DeviceControl,
    type DeviceDetails,
    type DeviceInfo,
    type DeviceLoadContext,
    type InstanceDetails,
} from '@iobroker/dm-utils';
import type { ControlState } from '@iobroker/dm-utils/build/types/base';
import type { AdapterInstance } from '@iobroker/adapter-core';

/** Pattern: satellites.rooms.<room>.<deviceId> */
const SATELLITE_RE = /^satellites\.rooms\.([^.]+)\.([^.]+)$/;

export default class HannahDeviceManagement extends DeviceManagement<AdapterInstance> {
    /** @inheritdoc */
    public constructor(adapter: AdapterInstance) {
        super(adapter);
    }

    /** @inheritdoc */
    protected getInstanceInfo(): InstanceDetails {
        return {
            apiVersion: 'v3',
            smallCards: true,
        };
    }

    /** @inheritdoc */
    protected async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
        const devices = await this.adapter.getDevicesAsync();

        for (const device of devices) {
            const shortId = device._id.substring(this.adapter.namespace.length + 1);
            const match = shortId.match(SATELLITE_RE);
            if (!match) {
                continue;
            }

            const [, room, deviceId] = match;
            const ns = this.adapter.namespace;

            const onlineState = await this.adapter.getForeignStateAsync(`${device._id}.online`);
            const isOnline = onlineState?.val === true;

            const muteState = await this.adapter.getForeignStateAsync(`${ns}.satellites.rooms.${room}.mute`);
            const volumeState = await this.adapter.getForeignStateAsync(`${ns}.satellites.rooms.${room}.volume`);

            const controls: DeviceControl<string>[] = [
                {
                    id: 'mute',
                    type: 'switch',
                    stateId: `satellites.rooms.${room}.mute`,
                    label: { en: 'Mute', de: 'Stumm' },
                    state: muteState ?? ({ val: false, ts: Date.now(), ack: true } as ioBroker.State),
                    handler: async (_deviceId, _actionId, state: ControlState): Promise<ioBroker.State> => {
                        await this.adapter.setStateAsync(`satellites.rooms.${room}.mute`, {
                            val: state as boolean,
                            ack: false,
                        });
                        return { val: state, ts: Date.now(), ack: true } as ioBroker.State;
                    },
                },
                {
                    id: 'volume',
                    type: 'slider',
                    stateId: `satellites.rooms.${room}.volume`,
                    label: { en: 'Volume', de: 'Lautstärke' },
                    min: 0,
                    max: 100,
                    unit: '%',
                    state: volumeState ?? ({ val: 80, ts: Date.now(), ack: true } as ioBroker.State),
                    handler: async (_deviceId, _actionId, state: ControlState): Promise<ioBroker.State> => {
                        await this.adapter.setStateAsync(`satellites.rooms.${room}.volume`, {
                            val: state as number,
                            ack: false,
                        });
                        return { val: state, ts: Date.now(), ack: true } as ioBroker.State;
                    },
                },
            ];

            const info: DeviceInfo<string> = {
                id: device._id,
                name: (device.common.name as string) || deviceId,
                identifier: room,
                status: { connection: isOnline ? 'connected' : 'disconnected' },
                hasDetails: true,
                controls,
                actions: [],
            };

            context.addDevice(info);
        }
    }

    /** @inheritdoc */
    protected getDeviceDetails(id: string): DeviceDetails<string> | null {
        const shortId = id.substring(this.adapter.namespace.length + 1);
        const match = shortId.match(SATELLITE_RE);
        if (!match) {
            return null;
        }

        const [, room, deviceId] = match;

        return {
            id,
            schema: {
                type: 'panel',
                items: {
                    deviceId: {
                        type: 'staticInfo',
                        label: { en: 'Device ID', de: 'Geräte-ID' },
                        data: deviceId,
                        addColon: true,
                        copyToClipboard: true,
                    },
                    room: {
                        type: 'staticInfo',
                        label: { en: 'Room', de: 'Raum' },
                        data: room,
                        addColon: true,
                    },
                    online: {
                        type: 'state',
                        oid: `satellites.rooms.${room}.${deviceId}.online`,
                        control: 'text',
                        label: { en: 'Online', de: 'Online' },
                        addColon: true,
                    },
                },
            },
        };
    }
}
