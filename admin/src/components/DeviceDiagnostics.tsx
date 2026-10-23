import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { I18n } from '@iobroker/gui-components';

/** A finding in words, see `DiagnosticsFinding` in src/diagnostics-service.ts. */
interface Finding {
    severity: 'info' | 'warning';
    text: string;
    fix: string;
}

/** The answer of the adapter, see `DiagnosticsResult` in src/diagnostics-service.ts. */
interface Result {
    counts: { states: number; read: number; raw: number };
    devices: Array<{
        id: string;
        name: string;
        room: string;
        deviceClass: string;
        slots: Array<{ id: string; kind: string; writable: boolean; stateId: string; role: string; unit: string }>;
        genericSlots: string[];
        findings: Finding[];
    }>;
    notRead: Array<{ reason: string; fix: string; objects: Array<{ id: string; states: string[] }> }>;
    other: Finding[];
    notes: string[];
}

interface DeviceDiagnosticsProps {
    /** the settings in the form, saved or not */
    native: Record<string, any>;
    /** the connection to the admin */
    socket: any;
    /** e.g. hannah.0 */
    adapterNamespace: string;
}

interface DeviceDiagnosticsState {
    running: boolean;
    result: Result | null;
    error: string;
}

/** Shows what Hannah gets from the setup with the settings in the form, and what is left out and why. */
class DeviceDiagnostics extends React.Component<DeviceDiagnosticsProps, DeviceDiagnosticsState> {
    /** @inheritdoc */
    constructor(props: DeviceDiagnosticsProps) {
        super(props);
        this.state = { running: false, result: null, error: '' };
    }

    private async run(): Promise<void> {
        const { native, socket, adapterNamespace } = this.props;
        this.setState({ running: true, error: '' });
        try {
            const answer = (await socket.sendTo(adapterNamespace, 'getDiagnostics', {
                selectedRooms: native.selectedRooms || [],
                selectedFunctions: native.selectedFunctions || [],
                extraStatePrefixes: (native.extraStatePrefixes || []).map((p: { prefix: string }) => p.prefix),
            })) as Result | { error: string };
            if ('error' in answer) {
                this.setState({ running: false, error: answer.error });
            } else {
                this.setState({ running: false, result: answer });
            }
        } catch (e) {
            this.setState({ running: false, error: (e as Error).message });
        }
    }

    private renderFinding(f: Finding, key: number): React.JSX.Element {
        return (
            <Typography
                key={key}
                variant="body2"
                color={f.severity === 'warning' ? 'warning.main' : 'text.secondary'}
                sx={{ ml: 2 }}
            >
                {f.text}
                {f.fix ? ` ${I18n.t('Fix')}: ${f.fix}` : ''}
            </Typography>
        );
    }

    private renderResult(result: Result): React.JSX.Element {
        const { counts } = result;
        return (
            <Box sx={{ mt: 2 }}>
                <Typography variant="body2">
                    {I18n.t('States looked at')}: {counts.states}, {I18n.t('read by the adapter')}: {counts.read}
                    {counts.raw > 0 ? ` (${counts.raw} ${I18n.t('of them raw states, no devices')})` : ''},{' '}
                    {I18n.t('devices for Hannah')}: {result.devices.length}
                </Typography>
                {result.notes.map((n, i) => (
                    <Typography
                        key={i}
                        variant="body2"
                        color="warning.main"
                    >
                        {n}
                    </Typography>
                ))}

                <Typography
                    variant="h6"
                    sx={{ mt: 2 }}
                >
                    {I18n.t('Devices Hannah gets')}
                </Typography>
                {result.devices.map(d => (
                    <Box
                        key={d.id}
                        sx={{ mb: 1 }}
                    >
                        <Typography variant="subtitle2">
                            {d.room} · {d.name}: {d.deviceClass}{' '}
                            <Typography
                                component="span"
                                variant="caption"
                                color="text.secondary"
                            >
                                {d.id}
                            </Typography>
                        </Typography>
                        {d.slots.map(s => (
                            <Typography
                                key={s.id}
                                variant="body2"
                                sx={{ ml: 2 }}
                            >
                                {s.id} ({s.kind}, {s.writable ? 'rw' : 'ro'}) ← {s.stateId}
                                {[s.role, s.unit].filter(Boolean).length ? ` (${[s.role, s.unit].filter(Boolean).join(', ')})` : ''}
                            </Typography>
                        ))}
                        {d.genericSlots.length > 0 && (
                            <Typography
                                variant="body2"
                                sx={{ ml: 2 }}
                            >
                                + {d.genericSlots.length} {I18n.t('generic slots')}: {d.genericSlots.join(', ')}
                            </Typography>
                        )}
                        {d.findings.filter(f => f.severity === 'warning').map((f, i) => this.renderFinding(f, i))}
                    </Box>
                ))}

                {result.notRead.length > 0 && (
                    <Typography
                        variant="h6"
                        sx={{ mt: 2 }}
                    >
                        {I18n.t('States the adapter does not read')}
                    </Typography>
                )}
                {result.notRead.map(g => (
                    <Box
                        key={g.reason}
                        sx={{ mb: 1 }}
                    >
                        <Typography variant="subtitle2">
                            {g.objects.reduce((n, o) => n + o.states.length, 0)} {I18n.t('states')}: {g.reason}.
                        </Typography>
                        <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ ml: 2 }}
                        >
                            {I18n.t('Fix')}: {g.fix}
                        </Typography>
                        {g.objects.map(o => (
                            <Typography
                                key={o.id}
                                variant="body2"
                                sx={{ ml: 2 }}
                            >
                                {o.id}: {o.states.join(', ')}
                            </Typography>
                        ))}
                    </Box>
                ))}

                {result.other.length > 0 && (
                    <Typography
                        variant="h6"
                        sx={{ mt: 2 }}
                    >
                        {I18n.t('Other findings')}
                    </Typography>
                )}
                {result.other.map((f, i) => this.renderFinding(f, i))}
            </Box>
        );
    }

    /** @inheritdoc */
    render(): React.JSX.Element {
        const { running, result, error } = this.state;
        return (
            <Box sx={{ p: 2, color: 'text.primary' }}>
                <Typography
                    variant="body2"
                    sx={{ mb: 2, color: 'text.secondary' }}
                >
                    {I18n.t('Shows what Hannah gets with the room and function selection above, saved or not, and what is left out.')}
                </Typography>
                <Button
                    variant="contained"
                    disabled={running}
                    onClick={() => void this.run()}
                >
                    {running ? I18n.t('Checking...') : I18n.t('Check devices')}
                </Button>
                {error && (
                    <Typography
                        color="error"
                        sx={{ mt: 2 }}
                    >
                        {error}
                    </Typography>
                )}
                {result && this.renderResult(result)}
            </Box>
        );
    }
}

export default DeviceDiagnostics;
