import React from 'react';
import { withStyles } from '@material-ui/core/styles';
import type { CreateCSSProperties } from '@material-ui/core/styles/withStyles';
import AppBar from '@material-ui/core/AppBar';
import Tabs from '@material-ui/core/Tabs';
import Tab from '@material-ui/core/Tab';
import Box from '@material-ui/core/Box';
import TextField from '@material-ui/core/TextField';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableHead from '@material-ui/core/TableHead';
import TableRow from '@material-ui/core/TableRow';
import Button from '@material-ui/core/Button';
import IconButton from '@material-ui/core/IconButton';
import Typography from '@material-ui/core/Typography';
import I18n from '@iobroker/adapter-react/i18n';

const styles = (): Record<string, CreateCSSProperties> => ({
    tab: {
        padding: 16,
    },
    field: {
        marginBottom: 16,
        display: 'block',
    },
    fieldWide: {
        marginBottom: 16,
        display: 'block',
        minWidth: 400,
    },
    fieldNarrow: {
        marginBottom: 16,
        display: 'block',
        width: 120,
    },
    sectionTitle: {
        marginTop: 16,
        marginBottom: 8,
    },
    addButton: {
        marginTop: 8,
    },
    deleteButton: {
        padding: 4,
    },
    prefixCell: {
        paddingTop: 4,
        paddingBottom: 4,
    },
});

interface SettingsProps {
    classes: Record<string, string>;
    native: Record<string, any>;
    onChange: (attr: string, value: any) => void;
}

interface SettingsState {
    activeTab: number;
}

class Settings extends React.Component<SettingsProps, SettingsState> {
    constructor(props: SettingsProps) {
        super(props);
        this.state = { activeTab: 0 };
    }

    private getPrefixes(): Array<{ prefix: string }> {
        return this.props.native.extraStatePrefixes || [];
    }

    private addPrefix(): void {
        const prefixes = [...this.getPrefixes(), { prefix: '' }];
        this.props.onChange('extraStatePrefixes', prefixes);
    }

    private removePrefix(index: number): void {
        const prefixes = this.getPrefixes().filter((_, i) => i !== index);
        this.props.onChange('extraStatePrefixes', prefixes);
    }

    private updatePrefix(index: number, value: string): void {
        const prefixes = this.getPrefixes().map((p, i) => (i === index ? { prefix: value } : p));
        this.props.onChange('extraStatePrefixes', prefixes);
    }

    private renderConnectionTab(): React.JSX.Element {
        const { classes, native, onChange } = this.props;
        return (
            <Box className={classes.tab}>
                <TextField
                    label={I18n.t('Hannah Host')}
                    className={classes.fieldWide}
                    value={native.hannahHost || ''}
                    onChange={e => onChange('hannahHost', e.target.value)}
                    placeholder="192.168.1.100"
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('IP address or hostname of the Hannah Core server')}
                />
                <TextField
                    label={I18n.t('gRPC Port')}
                    className={classes.fieldNarrow}
                    value={native.hannahPort ?? 50051}
                    onChange={e => onChange('hannahPort', parseInt(e.target.value, 10) || 50051)}
                    type="number"
                    variant="outlined"
                    size="small"
                />
            </Box>
        );
    }

    private renderDiscoveryTab(): React.JSX.Element {
        const { classes, native, onChange } = this.props;
        const prefixes = this.getPrefixes();
        return (
            <Box className={classes.tab}>
                <TextField
                    label={I18n.t('Functions Enum')}
                    className={classes.fieldWide}
                    value={native.enumFunctions || ''}
                    onChange={e => onChange('enumFunctions', e.target.value)}
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('ioBroker enum for device functions (e.g. lights, heating)')}
                />
                <TextField
                    label={I18n.t('Rooms Enum')}
                    className={classes.fieldWide}
                    value={native.enumRooms || ''}
                    onChange={e => onChange('enumRooms', e.target.value)}
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('ioBroker enum for rooms')}
                />
                <Typography
                    variant="subtitle2"
                    className={classes.sectionTitle}
                >
                    {I18n.t('Extra State Prefixes')}
                </Typography>
                <Typography
                    variant="body2"
                    color="textSecondary"
                    style={{ marginBottom: 8 }}
                >
                    {I18n.t('Additional state ID prefixes to stream to Hannah (e.g. 0_userdata.0)')}
                </Typography>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>{I18n.t('Prefix')}</TableCell>
                            <TableCell style={{ width: 48 }} />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {prefixes.map((item, i) => (
                            <TableRow key={i}>
                                <TableCell className={classes.prefixCell}>
                                    <TextField
                                        value={item.prefix}
                                        onChange={e => this.updatePrefix(i, e.target.value)}
                                        placeholder="0_userdata.0"
                                        size="small"
                                        fullWidth
                                    />
                                </TableCell>
                                <TableCell className={classes.prefixCell}>
                                    <IconButton
                                        className={classes.deleteButton}
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
                <Button
                    className={classes.addButton}
                    variant="outlined"
                    size="small"
                    onClick={() => this.addPrefix()}
                >
                    + {I18n.t('Add prefix')}
                </Button>
            </Box>
        );
    }

    private renderIntegrationsTab(): React.JSX.Element {
        const { classes, native, onChange } = this.props;
        return (
            <Box className={classes.tab}>
                <TextField
                    label={I18n.t('Residents State Prefix')}
                    className={classes.fieldWide}
                    value={native.residentsStatePrefix || ''}
                    onChange={e => onChange('residentsStatePrefix', e.target.value)}
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('ioBroker state prefix for the residents adapter (roomies)')}
                />
                <TextField
                    label={I18n.t('Residents Guest Prefix')}
                    className={classes.fieldWide}
                    value={native.residentsGuestPrefix || ''}
                    onChange={e => onChange('residentsGuestPrefix', e.target.value)}
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('ioBroker state prefix for guest presence')}
                />
                <TextField
                    label={I18n.t('Residents State Key')}
                    className={classes.fieldWide}
                    value={native.residentsStateKey || ''}
                    onChange={e => onChange('residentsStateKey', e.target.value)}
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('Sub-key for presence value under each resident (default: mood.state)')}
                />
                <TextField
                    label={I18n.t('Text Command State ID')}
                    className={classes.fieldWide}
                    value={native.textCommandStateId || ''}
                    onChange={e => onChange('textCommandStateId', e.target.value)}
                    variant="outlined"
                    size="small"
                    helperText={I18n.t('ioBroker state ID to watch for text commands sent to Hannah')}
                />
            </Box>
        );
    }

    render(): React.JSX.Element {
        const { activeTab } = this.state;
        return (
            <div>
                <AppBar
                    position="static"
                    color="default"
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
                    </Tabs>
                </AppBar>
                {activeTab === 0 && this.renderConnectionTab()}
                {activeTab === 1 && this.renderDiscoveryTab()}
                {activeTab === 2 && this.renderIntegrationsTab()}
            </div>
        );
    }
}

export default withStyles(styles)(Settings);
