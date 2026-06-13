import React, { useEffect, useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ESPLoader, Transport, UsbJtagSerialReset } from 'esptool-js';
import { encodeNVS } from '@m1kad0/esp-nvs-utils';
import { I18n } from '@iobroker/adapter-react-v5';
import type { AdminConnection } from '@iobroker/adapter-react-v5';
import type { SatelliteDefaults } from './settings';

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
    tlsSkipVerify: boolean;
}

type FlashStep = 'config' | 'connecting' | 'flashing' | 'monitoring' | 'done' | 'error';

interface Props {
    open: boolean;
    onClose: () => void;
    socket: AdminConnection;
    adapterNamespace: string;
    defaults?: SatelliteDefaults;
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

const buildConfigFromDefaults = (defaults?: SatelliteDefaults): FlashConfig => ({
    deviceId: '',
    room: '',
    wifiSsid: defaults?.wifiSsid ?? '',
    wifiPass: defaults?.wifiPass ?? '',
    mqttBroker: defaults?.mqttBroker ?? '',
    mqttPort: defaults?.mqttPort ?? '1883',
    mqttUser: defaults?.mqttUser ?? '',
    mqttPass: defaults?.mqttPass ?? '',
    otaUrl: defaults?.otaUrl ?? '',
    otaChannel: defaults?.otaChannel ?? 'satellite-esp-stable',
    otaToken: defaults?.otaToken ?? '',
    assetUrl: defaults?.assetUrl ?? '',
    assetToken: defaults?.assetToken ?? '',
    tlsSkipVerify: defaults?.tlsSkipVerify ?? false,
});

const FlashDialog: React.FC<Props> = ({ open, onClose, socket, adapterNamespace, defaults }) => {
    const [config, setConfig] = useState<FlashConfig>(() => buildConfigFromDefaults(defaults));
    const [configExpanded, setConfigExpanded] = useState(false);

    const [step, setStep] = useState<FlashStep>('config');
    const [log, setLog] = useState<string[]>([]);
    const [progress, setProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const [firmwareVersion, setFirmwareVersion] = useState('');
    const logRef = useRef<HTMLDivElement>(null);
    const monitorReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
    const portRef = useRef<any>(null);
    const transportRef = useRef<Transport | null>(null);

    useEffect(() => {
        if (open) {
            const cfg = buildConfigFromDefaults(defaults);
            setConfig(cfg);
            setConfigExpanded(!cfg.wifiSsid || !cfg.mqttBroker);
            setStep('config');
            setLog([]);
            setProgress(0);
            setErrorMsg('');
            setFirmwareVersion('');
        }
    }, [open]); // deps intentionally omitted: reset only on open, not on defaults change

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

    // Releases the WebSerial port completely: cancels the monitor reader,
    // disconnects the esptool transport and closes the raw port. Without the
    // port.close() the serial connection stayed open until the whole page was
    // left. Every step is defensive — the reader/transport/port may already be
    // gone depending on which step the dialog was closed in.
    const cleanupSerial = useCallback(async (): Promise<void> => {
        const reader = monitorReaderRef.current;
        if (reader) {
            monitorReaderRef.current = null;
            try {
                await reader.cancel();
            } catch {
                // ignore
            }
            try {
                reader.releaseLock();
            } catch {
                // ignore
            }
        }
        const transport = transportRef.current;
        if (transport) {
            transportRef.current = null;
            try {
                await transport.disconnect();
            } catch {
                // ignore
            }
        }
        const port = portRef.current;
        if (port) {
            portRef.current = null;
            try {
                await port.close();
            } catch {
                // ignore
            }
        }
    }, []);

    const handleClose = (): void => {
        void cleanupSerial();
        onClose();
    };

    // Safety net: release the serial port if the dialog unmounts without an
    // explicit close (e.g. the admin tab is navigated away).
    useEffect(
        () => () => {
            void cleanupSerial();
        },
        [cleanupSerial],
    );

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
            addLog(I18n.t('Loading firmware from adapter...'));
            const fw = (await (socket as any).sendTo(adapterNamespace, 'getFirmwareFiles', {})) as FirmwareResult;

            if (fw.error || !fw.files?.length) {
                throw new Error(fw.error ?? I18n.t('No firmware files received'));
            }
            addLog(
                `${I18n.t('Firmware loaded:')} ${fw.version ?? I18n.t('unknown version')} (${fw.files.length} ${I18n.t('files')})`,
            );
            setFirmwareVersion(fw.version ?? '');

            // 2. Generate NVS partition
            addLog(I18n.t('Generating NVS partition...'));
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
                    { name: 'ww_threshold', encoding: 'u8', value: 75 },
                    { name: 'tls_skip', encoding: 'u8', value: config.tlsSkipVerify ? 1 : 0 },
                ],
            });

            // Pad NVS to partition size
            const nvsPartition = new Uint8Array(NVS_SIZE);
            nvsPartition.fill(0xff);
            nvsPartition.set(nvsData.slice(0, NVS_SIZE));
            addLog(`${I18n.t('NVS partition generated')} (${nvsData.byteLength} ${I18n.t('bytes')})`);

            // 3. Connect to ESP via WebSerial
            addLog(I18n.t('Opening WebSerial...'));
            const serial = (navigator as any).serial;
            if (!serial) {
                throw new Error(I18n.t('WebSerial is not supported by this browser (Chrome/Edge required)'));
            }
            const port = await serial.requestPort();
            portRef.current = port;
            const info = port.getInfo();
            const isUsbJtag = info.usbVendorId === 0x303a && info.usbProductId === 0x1001;
            const transport = new Transport(port, true);
            transportRef.current = transport;

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

            addLog(I18n.t('Connecting to ESP...'));
            const chipName = await esploader.main();
            addLog(`${I18n.t('Connected:')} ${chipName}`);

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

            addLog(`${I18n.t('Starting flash')} (${fileArray.length} ${I18n.t('partitions')})...`);

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
                        addLog(
                            `  ${fileIndex < fw.files!.length ? fw.files![fileIndex].name : 'nvs'}: ${I18n.t('done')}`,
                        );
                    }
                    const pct = (filesDone / totalFiles + (written / total) * (1 / totalFiles)) * 100;
                    setProgress(Math.min(pct, 99));
                },
            });

            setProgress(100);
            addLog(I18n.t('Flash complete.'));
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
            transportRef.current = null;

            // Monitor: reopen port after reboot
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
                // closed by user or error
            }
            monitorReaderRef.current = null;
            setStep('done');
        } catch (err: any) {
            await cleanupSerial();
            setErrorMsg(err?.message ?? String(err));
            setStep('error');
            addLog(`${I18n.t('Error:')} ${err?.message ?? err}`);
        }
    };

    const set = (field: keyof FlashConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setConfig(prev => ({ ...prev, [field]: e.target.value }));

    const setCheck = (field: keyof FlashConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setConfig(prev => ({ ...prev, [field]: e.target.checked }));

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
            <DialogTitle>{I18n.t('Flash new satellite')}</DialogTitle>
            <DialogContent>
                {(step === 'config' || step === 'connecting' || step === 'flashing') && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
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
                                label={I18n.t('Room')}
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
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                cursor: step === 'config' ? 'pointer' : 'default',
                                userSelect: 'none',
                            }}
                            onClick={() => step === 'config' && setConfigExpanded(v => !v)}
                        >
                            <Typography
                                variant="subtitle2"
                                color="text.secondary"
                                sx={{ flex: 1 }}
                            >
                                {I18n.t('Configuration')}
                                {!configExpanded && config.wifiSsid && (
                                    <Typography
                                        component="span"
                                        variant="caption"
                                        color="text.disabled"
                                        sx={{ ml: 1 }}
                                    >
                                        {I18n.t('WiFi')}: {config.wifiSsid}
                                        {config.mqttBroker ? `, MQTT: ${config.mqttBroker}` : ''}
                                    </Typography>
                                )}
                            </Typography>
                            <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ ml: 1 }}
                            >
                                {configExpanded ? '▴' : '▾'}
                            </Typography>
                        </Box>
                        <Collapse in={configExpanded}>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    {I18n.t('WiFi')}
                                </Typography>
                                <Box sx={{ display: 'flex', gap: 2 }}>
                                    <TextField
                                        label={I18n.t('SSID')}
                                        value={config.wifiSsid}
                                        onChange={set('wifiSsid')}
                                        size="small"
                                        fullWidth
                                        disabled={step !== 'config'}
                                        required
                                    />
                                    <TextField
                                        label={I18n.t('Password')}
                                        value={config.wifiPass}
                                        onChange={set('wifiPass')}
                                        type="password"
                                        size="small"
                                        fullWidth
                                        disabled={step !== 'config'}
                                    />
                                </Box>

                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    {I18n.t('MQTT')}
                                </Typography>
                                <Box sx={{ display: 'flex', gap: 2 }}>
                                    <TextField
                                        label={I18n.t('Broker')}
                                        value={config.mqttBroker}
                                        onChange={set('mqttBroker')}
                                        size="small"
                                        fullWidth
                                        placeholder="192.168.1.10"
                                        disabled={step !== 'config'}
                                        required
                                    />
                                    <TextField
                                        label={I18n.t('Port')}
                                        value={config.mqttPort}
                                        onChange={set('mqttPort')}
                                        size="small"
                                        sx={{ width: 100 }}
                                        disabled={step !== 'config'}
                                    />
                                </Box>
                                <Box sx={{ display: 'flex', gap: 2 }}>
                                    <TextField
                                        label={I18n.t('User')}
                                        value={config.mqttUser}
                                        onChange={set('mqttUser')}
                                        size="small"
                                        fullWidth
                                        disabled={step !== 'config'}
                                    />
                                    <TextField
                                        label={I18n.t('Password')}
                                        value={config.mqttPass}
                                        onChange={set('mqttPass')}
                                        type="password"
                                        size="small"
                                        fullWidth
                                        disabled={step !== 'config'}
                                    />
                                </Box>

                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    {I18n.t('OTA')}
                                </Typography>
                                <TextField
                                    label={I18n.t('OTA URL')}
                                    value={config.otaUrl}
                                    onChange={set('otaUrl')}
                                    size="small"
                                    fullWidth
                                    placeholder="https://update.example.com"
                                    disabled={step !== 'config'}
                                />
                                <Box sx={{ display: 'flex', gap: 2 }}>
                                    <TextField
                                        label={I18n.t('Channel')}
                                        value={config.otaChannel}
                                        onChange={set('otaChannel')}
                                        size="small"
                                        fullWidth
                                        disabled={step !== 'config'}
                                    />
                                    <TextField
                                        label={I18n.t('Token')}
                                        value={config.otaToken}
                                        onChange={set('otaToken')}
                                        type="password"
                                        size="small"
                                        fullWidth
                                        disabled={step !== 'config'}
                                    />
                                </Box>

                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    {I18n.t('Asset Server')}
                                </Typography>
                                <TextField
                                    label={I18n.t('Asset URL')}
                                    value={config.assetUrl}
                                    onChange={set('assetUrl')}
                                    size="small"
                                    fullWidth
                                    placeholder="https://hannah-asset.example.com"
                                    disabled={step !== 'config'}
                                />
                                <TextField
                                    label={I18n.t('Token')}
                                    value={config.assetToken}
                                    onChange={set('assetToken')}
                                    type="password"
                                    size="small"
                                    fullWidth
                                    disabled={step !== 'config'}
                                />
                                <FormControlLabel
                                    control={
                                        <Checkbox
                                            checked={config.tlsSkipVerify}
                                            onChange={setCheck('tlsSkipVerify')}
                                            disabled={step !== 'config'}
                                            color="warning"
                                        />
                                    }
                                    label={
                                        <Typography
                                            variant="body2"
                                            color="warning.main"
                                        >
                                            {I18n.t('Disable TLS certificate validation (insecure)')}
                                        </Typography>
                                    }
                                />
                            </Box>
                        </Collapse>

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
                            {I18n.t('Serial monitor — ESP booting...')}
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
                            {I18n.t('Flash successful!')}
                        </Typography>
                        {firmwareVersion && (
                            <Typography
                                variant="body2"
                                color="text.secondary"
                            >
                                {I18n.t('Firmware:')} {firmwareVersion}
                            </Typography>
                        )}
                        <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mt: 1 }}
                        >
                            {I18n.t('The satellite is now starting and connecting to WiFi.')}
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
                        <Button onClick={handleClose}>{I18n.t('Cancel')}</Button>
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
                            {I18n.t('Flash')}
                        </Button>
                    </>
                )}
                {(step === 'connecting' || step === 'flashing') && <Button disabled>{I18n.t('Please wait...')}</Button>}
                {step === 'monitoring' && (
                    <Button
                        variant="outlined"
                        onClick={() => {
                            void cleanupSerial();
                        }}
                    >
                        {I18n.t('Stop monitor')}
                    </Button>
                )}
                {(step === 'done' || step === 'error') && (
                    <Button
                        variant="contained"
                        onClick={handleClose}
                    >
                        {I18n.t('Close')}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
};

export default FlashDialog;
