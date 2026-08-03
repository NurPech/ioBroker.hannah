import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import { Utils, Theme } from '@iobroker/gui-components';
import type { ThemeName } from '@iobroker/gui-components';
import App from './app';

// ioBroker passes the admin's active theme as a URL param when embedding tabs — `theme=`
// on admin 8+, but the legacy adapter-react `react=` (e.g. "?newReact=true&react=dark") on
// admin 7 and earlier. Without either, Utils.getThemeName() falls back to matchMedia/
// localStorage guesswork that can disagree with the real admin theme.
const params = new URLSearchParams(window.location.search);
const themeParam = (params.get('theme') || params.get('react')) as ThemeName | null;
let themeName = Utils.getThemeName(themeParam);

function build(): void {
    const container = document.getElementById('root');
    if (!container) {
        return;
    }
    const root = createRoot(container);
    root.render(
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={Theme(themeName)}>
                <App
                    adapterName="hannah"
                    onThemeChange={(_theme: ThemeName) => {
                        themeName = _theme;
                        build();
                    }}
                />
            </ThemeProvider>
        </StyledEngineProvider>,
    );
}

build();
