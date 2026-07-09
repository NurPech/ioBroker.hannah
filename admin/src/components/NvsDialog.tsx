import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
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

interface NvsConfig {
    displayName: string;
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

type NvsStep = 'config' | 'connecting' | 'flashing' | 'done' | 'error';

interface Props {
    open: boolean;
    onClose: () => void;
    deviceId: string;
    displayName?: string;
    defaults?: SatelliteDefaults;
    socket?: AdminConnection;
    adapterNamespace?: string;
}

const NVS_OFFSET = 0x9000;
const NVS_SIZE = 0x5000;

const NvsDialog: React.FC<Props> = ({ open, onClose, deviceId, displayName, defaults, socket, adapterNamespace }) => {
    const [config, setConfig] = useState<NvsConfig>({
        displayName: '',
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
        tlsSkipVerify: false,
    });

    const [step, setStep] = useState<NvsStep>('config');
    const [log, setLog] = useState<string[]>([]);
    const [progress, setProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) {
            setConfig({
                displayName: displayName || deviceId,
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
            setStep('config');
            setLog([]);
            setProgress(0);
            setErrorMsg('');
        }
    }, [open, deviceId, defaults]);

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

    const handleFlash = async (): Promise<void> => {
        setStep('connecting');
        setLog([]);
        setProgress(0);
        setErrorMsg('');

        try {
            // Rewriting NVS on an already-known, already-paired satellite must never
            // regenerate the pairing seed or re-provision it with Hannah Core — that
            // would force an unwanted re-pair handshake on every plain field edit.
            // Re-pairing an existing satellite is out of scope for this dialog.
            addLog(I18n.t('Generating NVS partition...'));
            const nvsData = encodeNVS({
                hannah: [
                    { name: 'wifi_ssid', encoding: 'string', value: config.wifiSsid },
                    { name: 'wifi_pass', encoding: 'string', value: config.wifiPass },
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

            const nvsPartition = new Uint8Array(NVS_SIZE);
            nvsPartition.fill(0xff);
            nvsPartition.set(nvsData.slice(0, NVS_SIZE));
            addLog(`${I18n.t('NVS partition generated')} (${nvsData.byteLength} ${I18n.t('bytes')})`);

            addLog(I18n.t('Opening WebSerial...'));
            const serial = (navigator as any).serial;
            if (!serial) {
                throw new Error(I18n.t('WebSerial is not supported by this browser (Chrome/Edge required)'));
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

            addLog(I18n.t('Connecting to ESP...'));
            const chipName = await esploader.main();
            addLog(`${I18n.t('Connected:')} ${chipName}`);

            setStep('flashing');
            addLog(I18n.t('Writing NVS partition...'));

            await esploader.writeFlash({
                fileArray: [{ data: nvsPartition, address: NVS_OFFSET }],
                flashMode: 'dio',
                flashFreq: '80m',
                flashSize: '16MB',
                eraseAll: false,
                compress: true,
                reportProgress: (_, written, total) => {
                    setProgress(total > 0 ? Math.round((written / total) * 100) : 0);
                },
            });

            setProgress(100);
            addLog(I18n.t('NVS written.'));

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
            setStep('done');
        } catch (err: any) {
            setErrorMsg(err?.message ?? String(err));
            setStep('error');
            addLog(`${I18n.t('Error:')} ${err?.message ?? err}`);
        }
    };

    const set = (field: keyof NvsConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setConfig(prev => ({ ...prev, [field]: e.target.value }));

    const setCheck = (field: keyof NvsConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setConfig(prev => ({ ...prev, [field]: e.target.checked }));

    const canFlash = config.displayName.trim() !== '' && config.wifiSsid.trim() !== '' && config.mqttBroker.trim() !== '';

    return (
        <Dialog
            open={open}
            onClose={step === 'connecting' || step === 'flashing' ? undefined : onClose}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>
                {I18n.t('Rewrite NVS')} — {deviceId}
            </DialogTitle>
            <DialogContent>
                {(step === 'config' || step === 'connecting' || step === 'flashing') && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <TextField
                            label={I18n.t('Display Name')}
                            value={config.displayName}
                            onChange={set('displayName')}
                            size="small"
                            fullWidth
                            disabled={step !== 'config'}
                            required
                        />

                        <Divider />
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

                        {(step === 'connecting' || step === 'flashing') && (
                            <Box sx={{ mt: 1 }}>
                                {step === 'flashing' ? (
                                    <LinearProgress
                                        variant="determinate"
                                        value={progress}
                                        sx={{ mb: 1 }}
                                    />
                                ) : (
                                    <LinearProgress sx={{ mb: 1 }} />
                                )}
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

                {step === 'done' && (
                    <Box sx={{ textAlign: 'center', py: 2 }}>
                        <Typography
                            variant="h6"
                            color="success.main"
                            sx={{ mb: 1 }}
                        >
                            {I18n.t('NVS successfully written!')}
                        </Typography>
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            {I18n.t('The satellite is restarting and connecting to WiFi.')}
                        </Typography>
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
                        <Button onClick={onClose}>{I18n.t('Cancel')}</Button>
                        <Button
                            variant="contained"
                            onClick={() => void handleFlash()}
                            disabled={!canFlash}
                        >
                            {I18n.t('Write NVS')}
                        </Button>
                    </>
                )}
                {(step === 'connecting' || step === 'flashing') && <Button disabled>{I18n.t('Please wait...')}</Button>}
                {(step === 'done' || step === 'error') && (
                    <Button
                        variant="contained"
                        onClick={onClose}
                    >
                        {I18n.t('Close')}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
};

export default NvsDialog;
