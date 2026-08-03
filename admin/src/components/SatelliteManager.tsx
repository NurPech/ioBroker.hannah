import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Fab from '@mui/material/Fab';
import Grid from '@mui/material/Grid';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { I18n } from '@iobroker/gui-components';
import type { AdminConnection } from '@iobroker/gui-components';
import FlashDialog from './FlashDialog';
import NvsDialog from './NvsDialog';
import type { SatelliteDefaults } from './settings';

interface IoBrokerObject {
    _id: string;
    type: string;
    common?: { name?: string | Record<string, string> };
}

interface IoBrokerState {
    val?: unknown;
    ack?: boolean;
    ts?: number;
}

interface Satellite {
    deviceId: string;
    deviceName: string;
    room: string;
    namespace: string;
    objectId: string;
    online: boolean;
    address: string;
    firmwareVersion: string;
    updateAvailable: boolean;
}

function parseSatellites(
    objects: Record<string, IoBrokerObject>,
    states: Record<string, IoBrokerState | null>,
): Satellite[] {
    const result: Satellite[] = [];
    const devicePattern = /^(hannah\.\d+)\.satellites\.rooms\.([^.]+)\.([^.]+)$/;
    for (const [id, obj] of Object.entries(objects)) {
        if (obj.type !== 'device') {
            continue;
        }
        const m = id.match(devicePattern);
        if (!m) {
            continue;
        }
        const [, namespace, roomId, deviceId] = m;
        const base = `${namespace}.satellites.rooms.${roomId}.${deviceId}`;
        const roomObj = objects[`${namespace}.satellites.rooms.${roomId}`];
        const roomName = typeof roomObj?.common?.name === 'string' ? roomObj.common.name.replace(/^Room /, '') : roomId;
        const deviceName = typeof obj.common?.name === 'string' ? obj.common.name.replace(/^Satellite /, '') : deviceId;
        result.push({
            deviceId,
            deviceName,
            room: roomName,
            namespace,
            objectId: base,
            online: states[`${base}.online`]?.val === true,
            address: (states[`${base}.address`]?.val as string | undefined) ?? '',
            firmwareVersion: (states[`${base}.firmware_version`]?.val as string | undefined) ?? '',
            updateAvailable: states[`${base}.update_available`]?.val === true,
        });
    }
    result.sort((a, b) => a.room.localeCompare(b.room) || a.deviceName.localeCompare(b.deviceName));
    return result;
}

interface Props {
    socket: AdminConnection;
}

const SatelliteManager: React.FC<Props> = ({ socket }) => {
    const [satellites, setSatellites] = useState<Satellite[]>([]);
    const [objectsCache, setObjectsCache] = useState<Record<string, IoBrokerObject>>({});
    const [statesCache, setStatesCache] = useState<Record<string, IoBrokerState | null>>({});
    const [flashOpen, setFlashOpen] = useState(false);
    const [nvsTarget, setNvsTarget] = useState<{ deviceId: string; displayName: string; room: string; online: boolean } | null>(null);
    const [satelliteDefaults, setSatelliteDefaults] = useState<SatelliteDefaults>({});

    const adapterNamespace = 'hannah.0';

    useEffect(() => {
        void (socket as any).getObject('system.adapter.hannah.0').then((obj: any) => {
            if (obj?.native) {
                const n = obj.native;
                setSatelliteDefaults({
                    wifiSsid: n.satWifiSsid,
                    wifiPass: n.satWifiPass,
                    mqttBroker: n.satMqttBroker,
                    mqttPort: n.satMqttPort,
                    mqttUser: n.satMqttUser,
                    mqttPass: n.satMqttPass,
                    otaUrl: n.satOtaUrl,
                    otaChannel: n.satOtaChannel,
                    otaToken: n.satOtaToken,
                    assetUrl: n.satAssetUrl,
                    assetToken: n.satAssetToken,
                    tlsSkipVerify: n.satTlsSkipVerify,
                    nvsToken: n.satNvsToken,
                });
            }
        });
    }, [socket]);

    useEffect(() => {
        let mounted = true;

        const load = async (): Promise<void> => {
            const [deviceObjs, folderObjs, states] = await Promise.all([
                socket.getForeignObjects('hannah.*.satellites.rooms.*.*', 'device') as Promise<
                    Record<string, IoBrokerObject>
                >,
                socket.getForeignObjects('hannah.*.satellites.rooms.*', 'folder') as Promise<
                    Record<string, IoBrokerObject>
                >,
                socket.getForeignStates('hannah.*.satellites.rooms.*.*.*'),
            ]);
            const allObjs = { ...folderObjs, ...deviceObjs };
            if (!mounted) {
                return;
            }
            setObjectsCache(allObjs);
            setStatesCache(states as Record<string, IoBrokerState | null>);
            setSatellites(parseSatellites(allObjs, states as Record<string, IoBrokerState | null>));
        };

        void load();

        const onStateChange = (id: string, state: IoBrokerState | null | undefined): void => {
            if (!id.includes('.satellites.rooms.')) {
                return;
            }
            setStatesCache(prev => {
                const next = { ...prev, [id]: state ?? null };
                setSatellites(() => parseSatellites(objectsCache, next));
                return next;
            });
        };

        void socket.subscribeState('hannah.*.satellites.rooms.*.*.*', onStateChange);

        return () => {
            mounted = false;
            socket.unsubscribeState('hannah.*.satellites.rooms.*.*.*', onStateChange);
        };
    }, [socket]);

    // Keep objectsCache accessible in the closure
    useEffect(() => {
        setSatellites(parseSatellites(objectsCache, statesCache));
    }, [objectsCache, statesCache]);

    return (
        <Box sx={{ p: 3, position: 'relative', minHeight: '100%' }}>
            <FlashDialog
                open={flashOpen}
                onClose={() => setFlashOpen(false)}
                socket={socket}
                adapterNamespace={adapterNamespace}
                defaults={satelliteDefaults}
            />
            <NvsDialog
                open={nvsTarget !== null}
                onClose={() => setNvsTarget(null)}
                deviceId={nvsTarget?.deviceId ?? ''}
                displayName={nvsTarget?.displayName ?? ''}
                online={nvsTarget?.online ?? false}
                defaults={satelliteDefaults}
                socket={socket}
                adapterNamespace={adapterNamespace}
            />
            <Typography
                variant="h5"
                sx={{ mb: 3, fontWeight: 600, color: 'text.primary' }}
            >
                {I18n.t('Satellites')}
            </Typography>
            {satellites.length === 0 ? (
                <Typography sx={{ color: 'text.secondary' }}>{I18n.t('No satellites known.')}</Typography>
            ) : (
                <Grid
                    container
                    spacing={2}
                >
                    {satellites.map(sat => (
                        <Grid
                            key={sat.objectId}
                            size={{ xs: 12, sm: 6, md: 4, lg: 3 }}
                        >
                            <Card
                                variant="outlined"
                                sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                            >
                                <CardContent sx={{ flexGrow: 1 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                                        <Typography
                                            variant="h6"
                                            sx={{ flexGrow: 1, color: 'text.primary' }}
                                        >
                                            {sat.deviceName}
                                        </Typography>
                                        <Chip
                                            size="small"
                                            label={sat.online ? I18n.t('Online') : I18n.t('Offline')}
                                            color={sat.online ? 'success' : 'default'}
                                        />
                                    </Box>
                                    <Typography
                                        variant="body2"
                                        sx={{ mb: 1, color: 'text.secondary' }}
                                    >
                                        {sat.room}
                                    </Typography>
                                    {sat.firmwareVersion ? (
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <Typography
                                                variant="caption"
                                                sx={{ color: 'text.secondary' }}
                                            >
                                                {I18n.t('Firmware:')} {sat.firmwareVersion}
                                            </Typography>
                                            {sat.updateAvailable && (
                                                <Chip
                                                    size="small"
                                                    label={I18n.t('Update available')}
                                                    color="warning"
                                                />
                                            )}
                                        </Box>
                                    ) : null}
                                </CardContent>
                                <CardActions sx={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 0.5 }}>
                                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                                        {sat.address ? (
                                            <Button
                                                size="small"
                                                href={`http://${sat.address}/`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                {I18n.t('Configure')}
                                            </Button>
                                        ) : (
                                            <Button
                                                size="small"
                                                disabled
                                            >
                                                {I18n.t('Configure')}
                                            </Button>
                                        )}
                                        <Button
                                            size="small"
                                            variant="outlined"
                                            onClick={() => setNvsTarget({ deviceId: sat.deviceId, displayName: sat.deviceName, room: sat.room, online: sat.online })}
                                        >
                                            NVS
                                        </Button>
                                    </Box>
                                </CardActions>
                            </Card>
                        </Grid>
                    ))}
                </Grid>
            )}
            <Tooltip title={I18n.t('Flash new satellite')}>
                <Fab
                    color="success"
                    variant="extended"
                    onClick={() => setFlashOpen(true)}
                    sx={{ position: 'fixed', bottom: 24, right: 24 }}
                >
                    + {I18n.t('New Device')}
                </Fab>
            </Tooltip>
        </Box>
    );
};

export default SatelliteManager;
