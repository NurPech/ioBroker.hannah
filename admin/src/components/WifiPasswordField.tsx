import React, { useState } from 'react';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import { I18n } from '@iobroker/gui-components';

interface Props {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

/** True when the password starts or ends with a whitespace character (a typical copy-paste leftover). */
export function hasEdgeWhitespace(value: string): boolean {
    return value !== value.trim();
}

/**
 * WiFi password field of the satellite dialogs and the Satellite Defaults: a show/hide toggle
 * and a warning when the value starts or ends with whitespace. The value itself is never
 * changed, a WiFi password may legitimately contain spaces.
 */
const WifiPasswordField: React.FC<Props> = ({ value, onChange, disabled }) => {
    const [visible, setVisible] = useState(false);
    const warn = hasEdgeWhitespace(value);

    return (
        <TextField
            label={I18n.t('Password')}
            value={value}
            onChange={e => onChange(e.target.value)}
            type={visible ? 'text' : 'password'}
            size="small"
            fullWidth
            disabled={disabled}
            error={warn}
            helperText={warn ? I18n.t('The WiFi password starts or ends with a space. Please check it.') : undefined}
            slotProps={{
                input: {
                    endAdornment: (
                        <InputAdornment position="end">
                            <IconButton
                                size="small"
                                edge="end"
                                aria-label={visible ? I18n.t('Hide password') : I18n.t('Show password')}
                                title={visible ? I18n.t('Hide password') : I18n.t('Show password')}
                                onClick={() => setVisible(v => !v)}
                            >
                                {visible ? '🙈' : '👁'}
                            </IconButton>
                        </InputAdornment>
                    ),
                },
            }}
        />
    );
};

export default WifiPasswordField;
