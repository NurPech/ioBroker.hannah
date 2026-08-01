import {
    ACTIONS,
    DeviceManagement,
    type DeviceAction,
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

/** DeviceManagement implementation that exposes Hannah satellites in the ioBroker DeviceManager. */
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

            const muteState = await this.adapter.getForeignStateAsync(
                `${ns}.satellites.rooms.${room}.${deviceId}.mute`,
            );
            const volumeState = await this.adapter.getForeignStateAsync(
                `${ns}.satellites.rooms.${room}.${deviceId}.volume`,
            );

            // Fire-and-forget: the actual RPC call + result logging already lives in
            // satellites.ts' onStateChange (update_now/restart) — reuse it instead of
            // duplicating the gRPC call here, which would need its own getGrpc() wiring.
            const pressButton = async (button: 'update_now' | 'restart'): Promise<void> => {
                await this.adapter.setStateAsync(`satellites.rooms.${room}.${deviceId}.${button}`, {
                    val: true,
                    ack: false,
                });
            };

            const actions: DeviceAction<string>[] = [
                {
                    id: ACTIONS.UPDATE,
                    icon: 'update',
                    description: { en: 'Update firmware', de: 'Firmware aktualisieren' },
                    handler: async () => {
                        await pressButton('update_now');
                        return { refresh: 'none' };
                    },
                },
                {
                    id: 'restart',
                    icon: 'refresh',
                    description: { en: 'Restart satellite', de: 'Satellit neu starten' },
                    confirmation: { en: 'Restart this satellite now?', de: 'Diesen Satelliten jetzt neu starten?' },
                    handler: async () => {
                        await pressButton('restart');
                        return { refresh: 'none' };
                    },
                },
            ];

            const controls: DeviceControl<string>[] = [
                {
                    id: 'mute',
                    type: 'switch',
                    stateId: `satellites.rooms.${room}.${deviceId}.mute`,
                    label: { en: 'Mute', de: 'Stumm' },
                    state: muteState ?? ({ val: false, ts: Date.now(), ack: true } as ioBroker.State),
                    handler: async (_deviceId, _actionId, state: ControlState): Promise<ioBroker.State> => {
                        await this.adapter.setStateAsync(`satellites.rooms.${room}.${deviceId}.mute`, {
                            val: state as boolean,
                            ack: false,
                        });
                        return { val: state, ts: Date.now(), ack: true } as ioBroker.State;
                    },
                },
                {
                    id: 'volume',
                    type: 'slider',
                    stateId: `satellites.rooms.${room}.${deviceId}.volume`,
                    label: { en: 'Volume', de: 'Lautstärke' },
                    min: 0,
                    max: 100,
                    unit: '%',
                    state: volumeState ?? ({ val: 80, ts: Date.now(), ack: true } as ioBroker.State),
                    handler: async (_deviceId, _actionId, state: ControlState): Promise<ioBroker.State> => {
                        await this.adapter.setStateAsync(`satellites.rooms.${room}.${deviceId}.volume`, {
                            val: state as number,
                            ack: false,
                        });
                        return { val: state, ts: Date.now(), ack: true } as ioBroker.State;
                    },
                },
            ];

            const info: DeviceInfo<string> = {
                id: device._id,
                name: device.common.name || deviceId,
                identifier: room,
                status: { connection: isOnline ? 'connected' : 'disconnected' },
                update: {
                    available: { stateId: `${ns}.satellites.rooms.${room}.${deviceId}.update_available` },
                    version: { stateId: `${ns}.satellites.rooms.${room}.${deviceId}.firmware_version` },
                },
                hasDetails: true,
                controls,
                actions,
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
                    lastSeen: {
                        type: 'state',
                        oid: `satellites.rooms.${room}.${deviceId}.last_seen`,
                        control: 'text',
                        label: { en: 'Last seen (UTC)', de: 'Zuletzt gesehen (UTC)' },
                        addColon: true,
                    },
                    firmwareVersion: {
                        type: 'state',
                        oid: `satellites.rooms.${room}.${deviceId}.firmware_version`,
                        control: 'text',
                        label: { en: 'Firmware version', de: 'Firmware-Version' },
                        addColon: true,
                    },
                    updateAvailable: {
                        type: 'state',
                        oid: `satellites.rooms.${room}.${deviceId}.update_available`,
                        control: 'text',
                        label: { en: 'Update available', de: 'Update verfügbar' },
                        addColon: true,
                    },
                },
            },
        };
    }
}
