import React, { useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ESPLoader, Transport, UsbJtagSerialReset } from 'esptool-js';
import { encodeNVS } from '@m1kad0/esp-nvs-utils';
import type { AdminConnection } from '@iobroker/adapter-react-v5';

interface FirmwareFile {
    name: string;
    offset: number;
    data: string; // base64
}

interface FirmwareResult {
    version?: string;
    files?: FirmwareFile[];
    error?: string;
}

interface FlashConfig {
    deviceId: string;
    room: string;
    wifiSsid: string;
    wifiPass: string;
    mqttBroker: string;
    mqttPort: string;
    mqttUser: string;
    mqttPass: string;
    otaUrl: string;
    otaChannel: string;
    otaToken: string;
    assetUrl: string;
    assetToken: string;
}

type FlashStep = 'config' | 'connecting' | 'flashing' | 'monitoring' | 'done' | 'error';

interface Props {
    open: boolean;
    onClose: () => void;
    socket: AdminConnection;
    adapterNamespace: string;
}

function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        arr[i] = binary.charCodeAt(i);
    }
    return arr;
}

const NVS_OFFSET = 0x9000;
const NVS_SIZE = 0x5000;

const FlashDialog: React.FC<Props> = ({ open, onClose, socket, adapterNamespace }) => {
    const [config, setConfig] = useState<FlashConfig>({
        deviceId: '',
        room: '',
        wifiSsid: '',
        wifiPass: '',
        mqttBroker: '',
        mqttPort: '1883',
        mqttUser: '',
        mqttPass: '',
        otaUrl: '',
        otaChannel: 'satellite-esp-stable',
        otaToken: '',
        assetUrl: '',
        assetToken: '',
    });

    const [step, setStep] = useState<FlashStep>('config');
    const [log, setLog] = useState<string[]>([]);
    const [progress, setProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const [firmwareVersion, setFirmwareVersion] = useState('');
    const logRef = useRef<HTMLDivElement>(null);
    const monitorReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

    const addLog = (line: string): void => {
        setLog(prev => {
            const next = [...prev, line];
            setTimeout(() => {
                if (logRef.current) {
                    logRef.current.scrollTop = logRef.current.scrollHeight;
                }
            }, 0);
            return next;
        });
    };

    const stopMonitor = useCallback((): void => {
        if (monitorReaderRef.current) {
            void monitorReaderRef.current.cancel();
            monitorReaderRef.current = null;
        }
    }, []);

    const handleClose = (): void => {
        stopMonitor();
        setStep('config');
        setLog([]);
        setProgress(0);
        setErrorMsg('');
        setFirmwareVersion('');
        onClose();
    };

    const handleFlash = async (): Promise<void> => {
        if (!config.deviceId || !config.room || !config.wifiSsid || !config.mqttBroker) {
            return;
        }

        setStep('connecting');
        setLog([]);
        setProgress(0);
        setErrorMsg('');

        try {
            // 1. Fetch firmware from adapter
            addLog('Lade Firmware vom Adapter...');
            const fw = (await (socket as any).sendTo(adapterNamespace, 'getFirmwareFiles', {})) as FirmwareResult;

            if (fw.error || !fw.files?.length) {
                throw new Error(fw.error ?? 'Keine Firmware-Dateien erhalten');
            }
            addLog(`Firmware geladen: ${fw.version ?? 'unbekannte Version'} (${fw.files.length} Dateien)`);
            setFirmwareVersion(fw.version ?? '');

            // 2. Generate NVS partition
            addLog('Generiere NVS-Partition...');
            const nvsData = encodeNVS({
                hannah: [
                    { name: 'wifi_ssid', encoding: 'string', value: config.wifiSsid },
                    { name: 'wifi_pass', encoding: 'string', value: config.wifiPass },
                    { name: 'device_id', encoding: 'string', value: config.deviceId },
                    { name: 'room', encoding: 'string', value: config.room },
                    { name: 'mqtt_broker', encoding: 'string', value: config.mqttBroker },
                    { name: 'mqtt_port', encoding: 'u16', value: parseInt(config.mqttPort, 10) || 1883 },
                    { name: 'mqtt_user', encoding: 'string', value: config.mqttUser },
                    { name: 'mqtt_pass', encoding: 'string', value: config.mqttPass },
                    { name: 'ota_url', encoding: 'string', value: config.otaUrl },
                    { name: 'ota_channel', encoding: 'string', value: config.otaChannel },
                    ...(config.otaToken
                        ? [{ name: 'ota_token', encoding: 'string' as const, value: config.otaToken }]
                        : []),
                    ...(config.assetUrl
                        ? [{ name: 'asset_url', encoding: 'string' as const, value: config.assetUrl }]
                        : []),
                    ...(config.assetToken
                        ? [{ name: 'asset_token', encoding: 'string' as const, value: config.assetToken }]
                        : []),
                    { name: 'wakeword', encoding: 'u8', value: 0 },
                    { name: 'ww_threshold', encoding: 'u8', value: 75 },
                ],
            });

            // Pad NVS to partition size
            const nvsPartition = new Uint8Array(NVS_SIZE);
            nvsPartition.fill(0xff);
            nvsPartition.set(nvsData.slice(0, NVS_SIZE));
            addLog(`NVS-Partition generiert (${nvsData.byteLength} Bytes)`);

            // 3. Connect to ESP via WebSerial
            addLog('Öffne WebSerial...');
            const serial = (navigator as any).serial;
            if (!serial) {
                throw new Error('WebSerial wird von diesem Browser nicht unterstützt (Chrome/Edge erforderlich)');
            }
            const port = await serial.requestPort();
            const info = port.getInfo();
            const isUsbJtag = info.usbVendorId === 0x303a && info.usbProductId === 0x1001;
            const transport = new Transport(port, true);

            const terminal = {
                clean: () => {},
                writeLine: (data: string) => addLog(data),
                write: (data: string) => addLog(data),
            };

            const esploader = new ESPLoader({
                transport,
                baudrate: 921600,
                terminal,
                resetConstructors: {
                    usbJTAGSerialReset: t => new UsbJtagSerialReset(t),
                },
            });

            addLog('Verbinde mit ESP...');
            const chipName = await esploader.main();
            addLog(`Verbunden: ${chipName}`);

            // 4. Build file array: firmware files + NVS
            setStep('flashing');
            const totalFiles = fw.files.length + 1;
            let filesDone = 0;

            const fileArray: Array<{ data: Uint8Array; address: number }> = [
                ...fw.files.map(f => ({
                    data: base64ToUint8Array(f.data),
                    address: f.offset,
                })),
                { data: nvsPartition, address: NVS_OFFSET },
            ];

            addLog(`Starte Flash (${fileArray.length} Partitionen)...`);

            await esploader.writeFlash({
                fileArray,
                flashMode: 'dio',
                flashFreq: '80m',
                flashSize: '16MB',
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    if (written === total && written > 0) {
                        filesDone = fileIndex + 1;
                        addLog(`  ${fileIndex < fw.files!.length ? fw.files![fileIndex].name : 'nvs'}: fertig`);
                    }
                    const pct = (filesDone / totalFiles + (written / total) * (1 / totalFiles)) * 100;
                    setProgress(Math.min(pct, 99));
                },
            });

            setProgress(100);
            addLog('Flash abgeschlossen.');
            if (isUsbJtag) {
                await esploader.after('no_reset');
                await port.setSignals({ dataTerminalReady: false, requestToSend: false });
                await new Promise(r => setTimeout(r, 50));
                await port.setSignals({ dataTerminalReady: true });
                await new Promise(r => setTimeout(r, 100));
                await port.setSignals({ dataTerminalReady: false });
            } else {
                await esploader.after('hard_reset');
            }
            await transport.disconnect();

            // Monitor: Port nach Reboot wieder öffnen
            setStep('monitoring');
            addLog('--- Monitor ---');
            await new Promise(r => setTimeout(r, 1500));
            try {
                await port.open({ baudRate: 115200 });
                const reader = (port.readable as ReadableStream<Uint8Array>).getReader();
                monitorReaderRef.current = reader;
                const decoder = new TextDecoder();
                let lineBuffer = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    lineBuffer += decoder.decode(value, { stream: true });
                    const lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop() ?? '';
                    for (const line of lines) {
                        const trimmed = line.replace(/\r$/, '');
                        if (trimmed) {
                            addLog(trimmed);
                        }
                    }
                }
            } catch {
                // Geschlossen durch Nutzer oder Fehler
            }
            monitorReaderRef.current = null;
            setStep('done');
        } catch (err: any) {
            setErrorMsg(err?.message ?? String(err));
            setStep('error');
            addLog(`Fehler: ${err?.message ?? err}`);
        }
    };

    const set = (field: keyof FlashConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setConfig(prev => ({ ...prev, [field]: e.target.value }));

    const canFlash =
        config.deviceId.trim() !== '' &&
        config.room.trim() !== '' &&
        config.wifiSsid.trim() !== '' &&
        config.mqttBroker.trim() !== '';

    return (
        <Dialog
            open={open}
            onClose={step === 'flashing' || step === 'connecting' ? undefined : handleClose}
            PaperProps={{ sx: { minHeight: step === 'monitoring' ? 420 : undefined } }}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>Neuen Satelliten flashen</DialogTitle>
            <DialogContent>
                {(step === 'config' || step === 'connecting' || step === 'flashing') && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <Typography
                            variant="subtitle2"
                            color="text.secondary"
                        >
                            Gerät
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Device ID"
                                value={config.deviceId}
                                onChange={set('deviceId')}
                                size="small"
                                fullWidth
                                placeholder="wohnzimmer-esp"
                                disabled={step !== 'config'}
                                required
                            />
                            <TextField
                                label="Raum"
                                value={config.room}
                                onChange={set('room')}
                                size="small"
                                fullWidth
                                placeholder="Wohnzimmer"
                                disabled={step !== 'config'}
                                required
                            />
                        </Box>

                        <Divider />
                        <Typography
                            variant="subtitle2"
                            color="text.secondary"
                        >
                            WiFi
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="SSID"
                                value={config.wifiSsid}
                                onChange={set('wifiSsid')}
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                                required
                            />
                            <TextField
                                label="Passwort"
                                value={config.wifiPass}
                                onChange={set('wifiPass')}
                                type="password"
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                            />
                        </Box>

                        <Divider />
                        <Typography
                            variant="subtitle2"
                            color="text.secondary"
                        >
                            MQTT
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Broker"
                                value={config.mqttBroker}
                                onChange={set('mqttBroker')}
                                size="small"
                                fullWidth
                                placeholder="192.168.1.10"
                                disabled={step !== 'config'}
                                required
                            />
                            <TextField
                                label="Port"
                                value={config.mqttPort}
                                onChange={set('mqttPort')}
                                size="small"
                                sx={{ width: 100 }}
                                disabled={step !== 'config'}
                            />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="User"
                                value={config.mqttUser}
                                onChange={set('mqttUser')}
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                            />
                            <TextField
                                label="Passwort"
                                value={config.mqttPass}
                                onChange={set('mqttPass')}
                                type="password"
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                            />
                        </Box>

                        <Divider />
                        <Typography
                            variant="subtitle2"
                            color="text.secondary"
                        >
                            OTA
                        </Typography>
                        <TextField
                            label="OTA URL"
                            value={config.otaUrl}
                            onChange={set('otaUrl')}
                            size="small"
                            fullWidth
                            placeholder="https://update.example.com"
                            disabled={step !== 'config'}
                        />
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Channel"
                                value={config.otaChannel}
                                onChange={set('otaChannel')}
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                            />
                            <TextField
                                label="Token"
                                value={config.otaToken}
                                onChange={set('otaToken')}
                                type="password"
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                            />
                        </Box>

                        <Divider />
                        <Typography
                            variant="subtitle2"
                            color="text.secondary"
                        >
                            Asset-Server
                        </Typography>
                        <TextField
                            label="Asset URL"
                            value={config.assetUrl}
                            onChange={set('assetUrl')}
                            size="small"
                            fullWidth
                            placeholder="https://hannah-asset.example.com"
                            disabled={step !== 'config'}
                        />
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Token"
                                value={config.assetToken}
                                onChange={set('assetToken')}
                                type="password"
                                size="small"
                                fullWidth
                                disabled={step !== 'config'}
                            />
                        </Box>

                        {(step === 'connecting' || step === 'flashing') && (
                            <Box sx={{ mt: 1 }}>
                                {step === 'flashing' && (
                                    <LinearProgress
                                        variant="determinate"
                                        value={progress}
                                        sx={{ mb: 1 }}
                                    />
                                )}
                                {step === 'connecting' && <LinearProgress sx={{ mb: 1 }} />}
                                <Box
                                    ref={logRef}
                                    sx={{
                                        fontFamily: 'monospace',
                                        fontSize: 12,
                                        bgcolor: 'background.default',
                                        border: '1px solid',
                                        borderColor: 'divider',
                                        borderRadius: 1,
                                        p: 1,
                                        maxHeight: 150,
                                        overflowY: 'auto',
                                        whiteSpace: 'pre-wrap',
                                    }}
                                >
                                    {log.map((line, i) => (
                                        <div key={i}>{line}</div>
                                    ))}
                                </Box>
                            </Box>
                        )}
                    </Box>
                )}

                {step === 'monitoring' && (
                    <Box sx={{ py: 1 }}>
                        <Typography
                            variant="subtitle2"
                            color="text.secondary"
                            sx={{ mb: 1 }}
                        >
                            Serieller Monitor — ESP bootet...
                        </Typography>
                        <Box
                            ref={logRef}
                            sx={{
                                fontFamily: 'monospace',
                                fontSize: 11,
                                bgcolor: 'background.default',
                                border: '1px solid',
                                borderColor: 'divider',
                                borderRadius: 1,
                                p: 1,
                                height: 300,
                                overflowY: 'auto',
                                whiteSpace: 'pre-wrap',
                            }}
                        >
                            {log.map((line, i) => (
                                <div key={i}>{line}</div>
                            ))}
                        </Box>
                    </Box>
                )}

                {step === 'done' && (
                    <Box sx={{ textAlign: 'center', py: 2 }}>
                        <Typography
                            variant="h6"
                            color="success.main"
                            sx={{ mb: 1 }}
                        >
                            Flash erfolgreich!
                        </Typography>
                        {firmwareVersion && (
                            <Typography
                                variant="body2"
                                color="text.secondary"
                            >
                                Firmware: {firmwareVersion}
                            </Typography>
                        )}
                        <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mt: 1 }}
                        >
                            Der Satellit startet jetzt und verbindet sich mit dem WLAN.
                        </Typography>
                        <Box
                            ref={logRef}
                            sx={{
                                fontFamily: 'monospace',
                                fontSize: 12,
                                bgcolor: 'background.default',
                                border: '1px solid',
                                borderColor: 'divider',
                                borderRadius: 1,
                                p: 1,
                                maxHeight: 120,
                                overflowY: 'auto',
                                mt: 2,
                                whiteSpace: 'pre-wrap',
                                textAlign: 'left',
                            }}
                        >
                            {log.map((line, i) => (
                                <div key={i}>{line}</div>
                            ))}
                        </Box>
                    </Box>
                )}

                {step === 'error' && (
                    <Box sx={{ py: 1 }}>
                        <Typography
                            color="error"
                            sx={{ mb: 1 }}
                        >
                            {errorMsg}
                        </Typography>
                        <Box
                            ref={logRef}
                            sx={{
                                fontFamily: 'monospace',
                                fontSize: 12,
                                bgcolor: 'background.default',
                                border: '1px solid',
                                borderColor: 'divider',
                                borderRadius: 1,
                                p: 1,
                                maxHeight: 150,
                                overflowY: 'auto',
                                whiteSpace: 'pre-wrap',
                            }}
                        >
                            {log.map((line, i) => (
                                <div key={i}>{line}</div>
                            ))}
                        </Box>
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                {step === 'config' && (
                    <>
                        <Button onClick={handleClose}>Abbrechen</Button>
                        <Button
                            variant="contained"
                            color="success"
                            onClick={() => void handleFlash()}
                            disabled={!canFlash}
                            startIcon={
                                <CircularProgress
                                    size={16}
                                    sx={{ display: 'none' }}
                                />
                            }
                        >
                            Flashen
                        </Button>
                    </>
                )}
                {(step === 'connecting' || step === 'flashing') && <Button disabled>Bitte warten...</Button>}
                {step === 'monitoring' && (
                    <Button
                        variant="outlined"
                        onClick={() => {
                            stopMonitor();
                        }}
                    >
                        Monitor beenden
                    </Button>
                )}
                {(step === 'done' || step === 'error') && (
                    <Button
                        variant="contained"
                        onClick={handleClose}
                    >
                        Schließen
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
};

export default FlashDialog;
