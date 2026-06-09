import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import { AdminConnection, Theme, Utils } from '@iobroker/adapter-react-v5';
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

socket.startSocket();

void socket.waitForFirstConnection().then(() => {
    const container = document.getElementById('root');
    if (!container) return;
    const root = createRoot(container);
    root.render(
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={Theme(Utils.getThemeName())}>
                <SatelliteManager socket={socket} />
            </ThemeProvider>
        </StyledEngineProvider>,
    );
});
