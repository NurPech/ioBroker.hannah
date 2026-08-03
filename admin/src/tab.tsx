import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import { AdminConnection, Theme, Utils } from '@iobroker/gui-components';
import type { ThemeName } from '@iobroker/gui-components';
import SatelliteManager from './components/SatelliteManager';

const socket = new AdminConnection({
    host: window.location.hostname,
    port: parseInt(window.location.port) || (window.location.protocol === 'https:' ? 443 : 8081),
    protocol: window.location.protocol as 'http:' | 'https:',
    autoSubscribes: [],
    autoSubscribeLog: false,
    doNotLoadAllObjects: true,
    doNotLoadACL: true,
});

void socket.startSocket();

void socket.waitForFirstConnection().then(() => {
    const container = document.getElementById('root');
    if (!container) {
        return;
    }
    const root = createRoot(container);
    // ioBroker passes the admin's active theme as a URL param when embedding tabs — `theme=`
    // on admin 8+, but the legacy adapter-react `react=` (e.g. "?newReact=true&react=dark") on
    // admin 7 and earlier. Without either, Utils.getThemeName() falls back to matchMedia/
    // localStorage guesswork that can disagree with the real admin theme.
    const params = new URLSearchParams(window.location.search);
    const themeParam = (params.get('theme') || params.get('react')) as ThemeName | null;
    root.render(
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={Theme(Utils.getThemeName(themeParam))}>
                <SatelliteManager socket={socket} />
            </ThemeProvider>
        </StyledEngineProvider>,
    );
});
