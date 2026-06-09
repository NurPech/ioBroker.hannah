import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { AdminConnection } from '@iobroker/adapter-react-v5';

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
    // Find all satellite device objects: <namespace>.satellites.rooms.<room>.<deviceId>
    const devicePattern = /^(hannah\.\d+)\.satellites\.rooms\.([^.]+)\.([^.]+)$/;
    for (const [id, obj] of Object.entries(objects)) {
        if (obj.type !== 'device') continue;
        const m = id.match(devicePattern);
        if (!m) continue;
        const [, namespace, roomId, deviceId] = m;
        const base = `${namespace}.satellites.rooms.${roomId}.${deviceId}`;
        const roomObj = objects[`${namespace}.satellites.rooms.${roomId}`];
        const roomName = typeof roomObj?.common?.name === 'string'
            ? roomObj.common.name.replace(/^Room /, '')
            : roomId;
        const deviceName = typeof obj.common?.name === 'string'
            ? obj.common.name.replace(/^Satellite /, '')
            : deviceId;
        result.push({
            deviceId,
            deviceName,
            room: roomName,
            namespace,
            objectId: base,
            online: states[`${base}.online`]?.val === true,
            address: String(states[`${base}.address`]?.val ?? ''),
            firmwareVersion: String(states[`${base}.firmware_version`]?.val ?? ''),
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

    useEffect(() => {
        let mounted = true;

        const load = async (): Promise<void> => {
            const [deviceObjs, folderObjs, states] = await Promise.all([
                socket.getForeignObjects('hannah.*.satellites.rooms.*.*', 'device') as Promise<Record<string, IoBrokerObject>>,
                socket.getForeignObjects('hannah.*.satellites.rooms.*', 'folder') as Promise<Record<string, IoBrokerObject>>,
                socket.getForeignStates('hannah.*.satellites.rooms.*.*.*'),
            ]);
            const allObjs = { ...folderObjs, ...deviceObjs };
            if (!mounted) return;
            setObjectsCache(allObjs);
            setStatesCache(states as Record<string, IoBrokerState | null>);
            setSatellites(parseSatellites(allObjs, states as Record<string, IoBrokerState | null>));
        };

        void load();

        const onStateChange = (id: string, state: IoBrokerState | null | undefined): void => {
            if (!id.includes('.satellites.rooms.')) return;
            setStatesCache(prev => {
                const next = { ...prev, [id]: state ?? null };
                setSatellites(sats => parseSatellites(objectsCache, next));
                return next;
            });
        };

        socket.subscribeState('hannah.*.satellites.rooms.*.*.*', onStateChange);

        return () => {
            mounted = false;
            socket.unsubscribeState('hannah.*.satellites.rooms.*.*.*', onStateChange);
        };
    }, [socket]);

    // Keep objectsCache accessible in the closure
    useEffect(() => {
        setSatellites(parseSatellites(objectsCache, statesCache));
    }, [objectsCache, statesCache]);

    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const handleDelete = async (sat: Satellite): Promise<void> => {
        const children = await socket.getForeignObjects(
            `${sat.objectId}.*`,
            'state',
        ) as Record<string, IoBrokerObject>;
        for (const id of Object.keys(children ?? {})) {
            await (socket as any).delObject(id);
        }
        await (socket as any).delObject(sat.objectId);
        setConfirmDeleteId(null);
        setObjectsCache(prev => {
            const next = { ...prev };
            delete next[sat.objectId];
            return next;
        });
    };

    return (
        <Box sx={{ p: 3 }}>
            <Typography variant="h5" color="text.primary" sx={{ mb: 3, fontWeight: 600 }}>
                Satelliten
            </Typography>
            {satellites.length === 0 ? (
                <Typography color="text.secondary">Keine Satelliten bekannt.</Typography>
            ) : (
                <Grid container spacing={2}>
                    {satellites.map(sat => (
                        <Grid item key={sat.objectId} xs={12} sm={6} md={4} lg={3}>
                            <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                                <CardContent sx={{ flexGrow: 1 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                                        <Typography variant="h6" sx={{ flexGrow: 1 }}>
                                            {sat.deviceName}
                                        </Typography>
                                        <Chip
                                            size="small"
                                            label={sat.online ? 'Online' : 'Offline'}
                                            color={sat.online ? 'success' : 'default'}
                                        />
                                    </Box>
                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                                        {sat.room}
                                    </Typography>
                                    {sat.firmwareVersion ? (
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <Typography variant="caption" color="text.secondary">
                                                Firmware: {sat.firmwareVersion}
                                            </Typography>
                                            {sat.updateAvailable && (
                                                <Chip size="small" label="Update" color="warning" />
                                            )}
                                        </Box>
                                    ) : null}
                                </CardContent>
                                <CardActions sx={{ justifyContent: 'space-between' }}>
                                    {sat.address ? (
                                        <Button
                                            size="small"
                                            href={`http://${sat.address}/`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            Konfigurieren
                                        </Button>
                                    ) : (
                                        <Button size="small" disabled>
                                            Konfigurieren
                                        </Button>
                                    )}
                                    {confirmDeleteId === sat.objectId ? (
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            <Typography variant="caption" color="error">Löschen?</Typography>
                                            <Button size="small" color="error" onClick={() => void handleDelete(sat)}>Ja</Button>
                                            <Button size="small" onClick={() => setConfirmDeleteId(null)}>Nein</Button>
                                        </Box>
                                    ) : (
                                        <Button size="small" color="error" onClick={() => setConfirmDeleteId(sat.objectId)}>
                                            Entfernen
                                        </Button>
                                    )}
                                </CardActions>
                            </Card>
                        </Grid>
                    ))}
                </Grid>
            )}
        </Box>
    );
};

export default SatelliteManager;
