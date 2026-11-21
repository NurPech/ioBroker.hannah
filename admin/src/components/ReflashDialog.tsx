import React, { useEffect, useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { ESPLoader, Transport, UsbJtagSerialReset } from 'esptool-js';
import { I18n } from '@iobroker/gui-components';
import { missingWebSerialMessage } from '../webserial';
import type { AdminConnection } from '@iobroker/gui-components';

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

type ReflashStep = 'ready' | 'connecting' | 'flashing' | 'monitoring' | 'done' | 'error';

interface Props {
    open: boolean;
    onClose: () => void;
    deviceId: string;
    displayName?: string;
    socket: AdminConnection;
    adapterNamespace: string;
}

// The flash dialog's text points at "Download image", which a reflash does not have.
const INSECURE_NOTE =
    'WebSerial needs a secure connection. Open the ioBroker admin over HTTPS or on localhost to reflash a satellite from the browser.';

// The NVS partition holds the WiFi, MQTT, OTA and asset settings, the display name, the
// room and the pairing seed. A reflash must never write it.
const NVS_OFFSET = 0x9000;

function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        arr[i] = binary.charCodeAt(i);
    }
    return arr;
}

// Flashes the firmware of an existing satellite over WebSerial and leaves its NVS
// partition alone: no new pairing seed, no ProvisionSatellite call, no settings to type.
const ReflashDialog: React.FC<Props> = ({ open, onClose, deviceId, displayName, socket, adapterNamespace }) => {
    const [step, setStep] = useState<ReflashStep>('ready');
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
            setStep('ready');
            setLog([]);
            setProgress(0);
            setErrorMsg('');
            setFirmwareVersion('');
        }
    }, [open]);

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

    // Releases the WebSerial port completely (monitor reader, esptool transport, raw port).
    // Every step is defensive: depending on the step the dialog was closed in, some are gone.
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

    // Safety net: release the serial port if the dialog unmounts without an explicit close.
    useEffect(
        () => () => {
            void cleanupSerial();
        },
        [cleanupSerial],
    );

    const handleReflash = async (): Promise<void> => {
        setStep('connecting');
        setLog([]);
        setProgress(0);
        setErrorMsg('');

        try {
            addLog(I18n.t('Loading firmware from adapter...'));
            const fw = (await (socket as any).sendTo(adapterNamespace, 'getFirmwareFiles', {})) as FirmwareResult;
            if (fw.error || !fw.files?.length) {
                throw new Error(fw.error ?? I18n.t('No firmware files received'));
            }
            // Bootloader, partition table, ota_data_initial and the app. A part at the NVS
            // offset would overwrite the satellite's settings, so it is dropped in any case.
            const parts = fw.files.filter(f => f.offset !== NVS_OFFSET);
            if (!parts.length) {
                throw new Error(I18n.t('No firmware files received'));
            }
            addLog(
                `${I18n.t('Firmware loaded:')} ${fw.version ?? I18n.t('unknown version')} (${parts.length} ${I18n.t('files')})`,
            );
            setFirmwareVersion(fw.version ?? '');

            addLog(I18n.t('Opening WebSerial...'));
            const serial = (navigator as any).serial;
            if (!serial) {
                throw new Error(
                    I18n.t(window.isSecureContext === false ? INSECURE_NOTE : missingWebSerialMessage(true)),
                );
            }
            const port = await serial.requestPort();
            portRef.current = port;
            const info = port.getInfo();
            const isUsbJtag = info.usbVendorId === 0x303a && info.usbProductId === 0x1001;
            const transport = new Transport(port, true);
            transportRef.current = transport;

            const esploader = new ESPLoader({
                transport,
                baudrate: 921600,
                terminal: {
                    clean: () => {},
                    writeLine: (data: string) => addLog(data),
                    write: (data: string) => addLog(data),
                },
                resetConstructors: {
                    usbJTAGSerialReset: t => new UsbJtagSerialReset(t),
                },
            });

            addLog(I18n.t('Connecting to ESP...'));
            const chipName = await esploader.main();
            addLog(`${I18n.t('Connected:')} ${chipName}`);

            setStep('flashing');
            addLog(`${I18n.t('Starting flash')} (${parts.length} ${I18n.t('partitions')})...`);
            let filesDone = 0;
            await esploader.writeFlash({
                fileArray: parts.map(f => ({ data: base64ToUint8Array(f.data), address: f.offset })),
                flashMode: 'dio',
                flashFreq: '80m',
                flashSize: '16MB',
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    if (written === total && written > 0) {
                        filesDone = fileIndex + 1;
                        addLog(`  ${parts[fileIndex]?.name ?? fileIndex}: ${I18n.t('done')}`);
                    }
                    const pct = (filesDone / parts.length + (written / total) * (1 / parts.length)) * 100;
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

            // Monitor: reopen the port after the reboot
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

    const logBox = (maxHeight: number, fontSize = 12): React.ReactElement => (
        <Box
            ref={logRef}
            sx={{
                fontFamily: 'monospace',
                fontSize,
                bgcolor: 'background.default',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                p: 1,
                maxHeight,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                textAlign: 'left',
            }}
        >
            {log.map((line, i) => (
                <div key={i}>{line}</div>
            ))}
        </Box>
    );

    const busy = step === 'connecting' || step === 'flashing';

    return (
        <Dialog
            open={open}
            onClose={busy ? undefined : handleClose}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>
                {I18n.t('Reflash satellite')}: {displayName || deviceId}
            </DialogTitle>
            <DialogContent>
                {step === 'ready' && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
                        <Typography variant="body2">
                            {I18n.t(
                                'Writes the firmware from the Firmware Source URL onto the satellite over the USB cable. The settings of the satellite (WiFi, MQTT, OTA, assets, name, room) are kept, it stays registered as it is.',
                            )}
                        </Typography>
                        <Typography
                            variant="body2"
                            sx={{ color: 'text.secondary' }}
                        >
                            {I18n.t('Connect the satellite to this computer and select its serial port in the next step.')}
                        </Typography>
                        {window.isSecureContext === false && (
                            <Typography
                                variant="body2"
                                sx={{ color: 'warning.main' }}
                            >
                                {I18n.t(INSECURE_NOTE)}
                            </Typography>
                        )}
                    </Box>
                )}

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
                        {logBox(150)}
                    </Box>
                )}

                {step === 'monitoring' && (
                    <Box sx={{ py: 1 }}>
                        <Typography
                            variant="subtitle2"
                            sx={{ mb: 1, color: 'text.secondary' }}
                        >
                            {I18n.t('Serial monitor — ESP booting...')}
                        </Typography>
                        {logBox(300, 11)}
                    </Box>
                )}

                {step === 'done' && (
                    <Box sx={{ textAlign: 'center', py: 2 }}>
                        <Typography
                            variant="h6"
                            sx={{ mb: 1, color: 'success.main' }}
                        >
                            {I18n.t('Flash successful!')}
                        </Typography>
                        {firmwareVersion && (
                            <Typography
                                variant="body2"
                                sx={{ color: 'text.secondary' }}
                            >
                                {I18n.t('Firmware:')} {firmwareVersion}
                            </Typography>
                        )}
                        <Typography
                            variant="body2"
                            sx={{ mt: 1, mb: 2, color: 'text.secondary' }}
                        >
                            {I18n.t('The satellite is now starting with its old settings.')}
                        </Typography>
                        {logBox(120)}
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
                        {logBox(150)}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                {step === 'ready' && (
                    <>
                        <Button onClick={handleClose}>{I18n.t('Cancel')}</Button>
                        <Button
                            variant="contained"
                            color="success"
                            onClick={() => void handleReflash()}
                        >
                            {I18n.t('Reflash')}
                        </Button>
                    </>
                )}
                {busy && <Button disabled>{I18n.t('Please wait...')}</Button>}
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

export default ReflashDialog;
