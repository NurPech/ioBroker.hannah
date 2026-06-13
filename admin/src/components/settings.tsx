import React from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { I18n } from '@iobroker/adapter-react-v5';
import type { EnumItem } from '../app';

/** Default NVS values pre-filled when flashing or rewriting a satellite. */
export interface SatelliteDefaults {
    /** WiFi SSID */
    wifiSsid?: string;
    /** WiFi password */
    wifiPass?: string;
    /** MQTT broker address */
    mqttBroker?: string;
    /** MQTT port (default 1883) */
    mqttPort?: string;
    /** MQTT username */
    mqttUser?: string;
    /** MQTT password */
    mqttPass?: string;
    /** OTA update server base URL */
    otaUrl?: string;
    /** OTA channel name */
    otaChannel?: string;
    /** OTA bearer token */
    otaToken?: string;
    /** Asset server base URL */
    assetUrl?: string;
    /** Asset server bearer token */
    assetToken?: string;
    /** Skip TLS certificate validation (for self-signed certs) */
    tlsSkipVerify?: boolean;
}

interface SettingsProps {
    native: Record<string, any>;
    onChange: (attr: string, value: any) => void;
    residentsInstances: string[];
    allRooms: EnumItem[];
    allFunctions: EnumItem[];
    enumsLoaded: boolean;
}

interface SettingsState {
    activeTab: number;
}

/** Settings component for the Hannah ioBroker adapter. */
class Settings extends React.Component<SettingsProps, SettingsState> {
    /** @inheritdoc */
    constructor(props: SettingsProps) {
        super(props);
        this.state = { activeTab: 0 };
    }

    private getPrefixes(): Array<{ prefix: string }> {
        return this.props.native.extraStatePrefixes || [];
    }

    private addPrefix(): void {
        this.props.onChange('extraStatePrefixes', [...this.getPrefixes(), { prefix: '' }]);
    }

    private removePrefix(index: number): void {
        this.props.onChange(
            'extraStatePrefixes',
            this.getPrefixes().filter((_, i) => i !== index),
        );
    }

    private updatePrefix(index: number, value: string): void {
        this.props.onChange(
            'extraStatePrefixes',
            this.getPrefixes().map((p, i) => (i === index ? { prefix: value } : p)),
        );
    }

    private getFloorMappings(): Array<{ label: string; abbreviation: string }> {
        return this.props.native.floorMappings || [];
    }

    private addFloorMapping(): void {
        this.props.onChange('floorMappings', [...this.getFloorMappings(), { label: '', abbreviation: '' }]);
    }

    private removeFloorMapping(index: number): void {
        this.props.onChange(
            'floorMappings',
            this.getFloorMappings().filter((_, i) => i !== index),
        );
    }

    private updateFloorMapping(index: number, field: 'label' | 'abbreviation', value: string): void {
        this.props.onChange(
            'floorMappings',
            this.getFloorMappings().map((m, i) => (i === index ? { ...m, [field]: value } : m)),
        );
    }

    private renderConnectionTab(): React.JSX.Element {
        const { native, onChange } = this.props;
        return (
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <TextField
                    label={I18n.t('Hannah Host')}
                    value={native.hannahHost || ''}
                    onChange={e => onChange('hannahHost', e.target.value)}
                    placeholder="192.168.1.100"
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('IP address or hostname of the Hannah Core server')}
                />
                <TextField
                    label={I18n.t('gRPC Port')}
                    value={native.hannahPort ?? 50051}
                    onChange={e => onChange('hannahPort', parseInt(e.target.value, 10) || 50051)}
                    type="number"
                    variant="outlined"
                    size="small"
                    sx={{ width: 150 }}
                />
            </Box>
        );
    }

    private renderEnumColumn(title: string, items: EnumItem[], selectedKey: string): React.JSX.Element {
        const { enumsLoaded } = this.props;
        const selected: string[] = this.props.native[selectedKey] || [];
        const toggle = (id: string): void => {
            const next = selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id];
            this.props.onChange(selectedKey, next);
        };

        return (
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box
                    sx={{
                        bgcolor: 'primary.main',
                        color: 'primary.contrastText',
                        px: 1.5,
                        py: 0.75,
                        borderRadius: '4px 4px 0 0',
                    }}
                >
                    <Typography variant="subtitle2">{title}</Typography>
                </Box>
                <Paper
                    variant="outlined"
                    sx={{ borderTop: 'none', borderRadius: '0 0 4px 4px', maxHeight: 380, overflowY: 'auto' }}
                >
                    {!enumsLoaded ? (
                        <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ p: 2 }}
                        >
                            {I18n.t('Loading...')}
                        </Typography>
                    ) : items.length === 0 ? (
                        <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ p: 2 }}
                        >
                            {I18n.t('No entries found')}
                        </Typography>
                    ) : (
                        items.map((item, idx) => (
                            <React.Fragment key={item.id}>
                                <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.5 }}>
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography
                                            variant="body2"
                                            noWrap
                                            fontWeight={selected.includes(item.id) ? 600 : 400}
                                        >
                                            {item.name}
                                        </Typography>
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                            noWrap
                                            sx={{ display: 'block' }}
                                        >
                                            {item.id}
                                        </Typography>
                                    </Box>
                                    <Switch
                                        size="small"
                                        checked={selected.includes(item.id)}
                                        onChange={() => toggle(item.id)}
                                    />
                                </Box>
                                {idx < items.length - 1 && <Divider />}
                            </React.Fragment>
                        ))
                    )}
                </Paper>
            </Box>
        );
    }

    private renderDiscoveryTab(): React.JSX.Element {
        const { allRooms, allFunctions } = this.props;
        const prefixes = this.getPrefixes();
        return (
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {I18n.t(
                        'Select which rooms and functions Hannah should know about. Leave all off to include everything.',
                    )}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
                    {this.renderEnumColumn(I18n.t('Rooms'), allRooms, 'selectedRooms')}
                    {this.renderEnumColumn(I18n.t('Functions'), allFunctions, 'selectedFunctions')}
                </Box>
                <Box>
                    <Typography
                        variant="subtitle2"
                        color="text.primary"
                        sx={{ mb: 0.5 }}
                    >
                        {I18n.t('Extra State Prefixes')}
                    </Typography>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mb: 1 }}
                    >
                        {I18n.t('Additional state ID prefixes to stream to Hannah (e.g. 0_userdata.0)')}
                    </Typography>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>{I18n.t('Prefix')}</TableCell>
                                <TableCell sx={{ width: 48 }} />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {prefixes.map((item, i) => (
                                <TableRow key={i}>
                                    <TableCell sx={{ py: 0.5 }}>
                                        <TextField
                                            value={item.prefix}
                                            onChange={e => this.updatePrefix(i, e.target.value)}
                                            placeholder="0_userdata.0"
                                            size="small"
                                            fullWidth
                                        />
                                    </TableCell>
                                    <TableCell sx={{ py: 0.5 }}>
                                        <IconButton
                                            size="small"
                                            onClick={() => this.removePrefix(i)}
                                        >
                                            ✕
                                        </IconButton>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    <Box sx={{ mt: 1 }}>
                        <Button
                            variant="outlined"
                            size="small"
                            onClick={() => this.addPrefix()}
                        >
                            + {I18n.t('Add prefix')}
                        </Button>
                    </Box>
                </Box>
                <Box>
                    <Typography
                        variant="subtitle2"
                        color="text.primary"
                        sx={{ mb: 0.5 }}
                    >
                        {I18n.t('Floor Mappings')}
                    </Typography>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mb: 1 }}
                    >
                        {I18n.t(
                            'Map floor labels or abbreviations found in state IDs to a canonical abbreviation (e.g. "Erdgeschoss" → "EG"). Leave empty to use built-in defaults (EG, OG, UG, DG, KG, ZG).',
                        )}
                    </Typography>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>{I18n.t('Label in ID path')}</TableCell>
                                <TableCell>{I18n.t('Abbreviation')}</TableCell>
                                <TableCell sx={{ width: 48 }} />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {this.getFloorMappings().map((item, i) => (
                                <TableRow key={i}>
                                    <TableCell sx={{ py: 0.5 }}>
                                        <TextField
                                            value={item.label}
                                            onChange={e => this.updateFloorMapping(i, 'label', e.target.value)}
                                            placeholder="Erdgeschoss"
                                            size="small"
                                            fullWidth
                                        />
                                    </TableCell>
                                    <TableCell sx={{ py: 0.5 }}>
                                        <TextField
                                            value={item.abbreviation}
                                            onChange={e => this.updateFloorMapping(i, 'abbreviation', e.target.value)}
                                            placeholder="EG"
                                            size="small"
                                            sx={{ width: 100 }}
                                        />
                                    </TableCell>
                                    <TableCell sx={{ py: 0.5 }}>
                                        <IconButton
                                            size="small"
                                            onClick={() => this.removeFloorMapping(i)}
                                        >
                                            ✕
                                        </IconButton>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    <Box sx={{ mt: 1 }}>
                        <Button
                            variant="outlined"
                            size="small"
                            onClick={() => this.addFloorMapping()}
                        >
                            + {I18n.t('Add floor mapping')}
                        </Button>
                    </Box>
                </Box>
            </Box>
        );
    }

    private renderSatelliteDefaultsTab(): React.JSX.Element {
        const { native, onChange } = this.props;
        return (
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 600 }}>
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {I18n.t(
                        'Default values pre-filled when flashing a new satellite or rewriting its NVS. Can be overridden per device.',
                    )}
                </Typography>

                <Typography
                    variant="subtitle2"
                    color="text.primary"
                >
                    {I18n.t('WiFi')}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2 }}>
                    <TextField
                        label={I18n.t('SSID')}
                        value={native.satWifiSsid || ''}
                        onChange={e => onChange('satWifiSsid', e.target.value)}
                        size="small"
                        fullWidth
                    />
                    <TextField
                        label={I18n.t('Password')}
                        value={native.satWifiPass || ''}
                        onChange={e => onChange('satWifiPass', e.target.value)}
                        type="password"
                        size="small"
                        fullWidth
                    />
                </Box>

                <Divider />
                <Typography
                    variant="subtitle2"
                    color="text.primary"
                >
                    {I18n.t('MQTT')}
                </Typography>
                <Box sx={{ display: 'flex', gap: 2 }}>
                    <TextField
                        label={I18n.t('Broker')}
                        value={native.satMqttBroker || ''}
                        onChange={e => onChange('satMqttBroker', e.target.value)}
                        size="small"
                        fullWidth
                        placeholder="192.168.1.10"
                    />
                    <TextField
                        label={I18n.t('Port')}
                        value={native.satMqttPort || '1883'}
                        onChange={e => onChange('satMqttPort', e.target.value)}
                        size="small"
                        sx={{ width: 100 }}
                    />
                </Box>
                <Box sx={{ display: 'flex', gap: 2 }}>
                    <TextField
                        label={I18n.t('User')}
                        value={native.satMqttUser || ''}
                        onChange={e => onChange('satMqttUser', e.target.value)}
                        size="small"
                        fullWidth
                    />
                    <TextField
                        label={I18n.t('Password')}
                        value={native.satMqttPass || ''}
                        onChange={e => onChange('satMqttPass', e.target.value)}
                        type="password"
                        size="small"
                        fullWidth
                    />
                </Box>

                <Divider />
                <Typography
                    variant="subtitle2"
                    color="text.primary"
                >
                    {I18n.t('OTA')}
                </Typography>
                <TextField
                    label={I18n.t('OTA URL')}
                    value={native.satOtaUrl || ''}
                    onChange={e => onChange('satOtaUrl', e.target.value)}
                    size="small"
                    fullWidth
                    placeholder="https://update.example.com"
                />
                <Box sx={{ display: 'flex', gap: 2 }}>
                    <TextField
                        label={I18n.t('Channel')}
                        value={native.satOtaChannel || 'satellite-esp-stable'}
                        onChange={e => onChange('satOtaChannel', e.target.value)}
                        size="small"
                        fullWidth
                    />
                    <TextField
                        label={I18n.t('Token')}
                        value={native.satOtaToken || ''}
                        onChange={e => onChange('satOtaToken', e.target.value)}
                        type="password"
                        size="small"
                        fullWidth
                    />
                </Box>

                <Divider />
                <Typography
                    variant="subtitle2"
                    color="text.primary"
                >
                    {I18n.t('Asset Server')}
                </Typography>
                <TextField
                    label={I18n.t('Asset URL')}
                    value={native.satAssetUrl || ''}
                    onChange={e => onChange('satAssetUrl', e.target.value)}
                    size="small"
                    fullWidth
                    placeholder="https://hannah-asset.example.com"
                />
                <TextField
                    label={I18n.t('Token')}
                    value={native.satAssetToken || ''}
                    onChange={e => onChange('satAssetToken', e.target.value)}
                    type="password"
                    size="small"
                    fullWidth
                />

                <Divider />
                <Switch
                    checked={!!native.satTlsSkipVerify}
                    onChange={e => onChange('satTlsSkipVerify', e.target.checked)}
                    color="warning"
                />
                <Typography
                    variant="body2"
                    color="warning.main"
                    component="span"
                >
                    {I18n.t('Disable TLS certificate validation (insecure)')}
                </Typography>
            </Box>
        );
    }

    private renderFirmwareTab(): React.JSX.Element {
        const { native, onChange } = this.props;
        return (
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 600 }}>
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {I18n.t(
                        'URL to the firmware ZIP file (served as .bin). Supports Hannah Update Server, GitHub/GitLab releases, or any direct URL. The file must contain a manifest.json and the binary files.',
                    )}
                </Typography>
                <TextField
                    label={I18n.t('Firmware Source URL')}
                    value={native.firmwareSourceUrl || ''}
                    onChange={e => onChange('firmwareSourceUrl', e.target.value)}
                    placeholder="https://update.example.com/releases/latest?channel=satellite-esp-stable-init"
                    variant="outlined"
                    size="small"
                    fullWidth
                />
                <TextField
                    label={I18n.t('Auth Token (optional)')}
                    value={native.firmwareSourceToken || ''}
                    onChange={e => onChange('firmwareSourceToken', e.target.value)}
                    type="password"
                    variant="outlined"
                    size="small"
                    fullWidth
                    helperText={I18n.t('Sent as Bearer token. Leave empty if the URL is public.')}
                />
            </Box>
        );
    }

    private renderIntegrationsTab(): React.JSX.Element {
        const { native, onChange, residentsInstances } = this.props;
        return (
            <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <FormControl size="small">
                    <InputLabel>{I18n.t('Residents Adapter Instance')}</InputLabel>
                    <Select
                        value={native.residentsInstance || ''}
                        label={I18n.t('Residents Adapter Instance')}
                        onChange={e => onChange('residentsInstance', e.target.value)}
                    >
                        {residentsInstances.length === 0 ? (
                            <MenuItem
                                value=""
                                disabled
                            >
                                {I18n.t('No residents adapter found')}
                            </MenuItem>
                        ) : (
                            residentsInstances.map(inst => (
                                <MenuItem
                                    key={inst}
                                    value={inst}
                                >
                                    residents.{inst}
                                </MenuItem>
                            ))
                        )}
                    </Select>
                </FormControl>
            </Box>
        );
    }

    /** @inheritdoc */
    render(): React.JSX.Element {
        const { activeTab } = this.state;
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <AppBar
                    position="static"
                    color="default"
                    elevation={1}
                >
                    <Tabs
                        value={activeTab}
                        onChange={(_, v: number) => this.setState({ activeTab: v })}
                        indicatorColor="primary"
                        textColor="primary"
                    >
                        <Tab label={I18n.t('Connection')} />
                        <Tab label={I18n.t('Device Discovery')} />
                        <Tab label={I18n.t('Integrations')} />
                        <Tab label={I18n.t('Firmware')} />
                        <Tab label={I18n.t('Satellite Defaults')} />
                    </Tabs>
                </AppBar>
                <Box sx={{ flex: 1, overflowY: 'auto', pb: '70px' }}>
                    {activeTab === 0 && this.renderConnectionTab()}
                    {activeTab === 1 && this.renderDiscoveryTab()}
                    {activeTab === 2 && this.renderIntegrationsTab()}
                    {activeTab === 3 && this.renderFirmwareTab()}
                    {activeTab === 4 && this.renderSatelliteDefaultsTab()}
                </Box>
            </Box>
        );
    }
}

export default Settings;
