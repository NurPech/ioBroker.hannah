import React from 'react';
import { GenericApp } from '@iobroker/adapter-react-v5';
import type { GenericAppProps, GenericAppSettings, GenericAppState } from '@iobroker/adapter-react-v5';
import Settings from './components/settings';

import enI18n from './i18n/en.json';
import deI18n from './i18n/de.json';
import ruI18n from './i18n/ru.json';
import ptI18n from './i18n/pt.json';
import nlI18n from './i18n/nl.json';
import frI18n from './i18n/fr.json';
import itI18n from './i18n/it.json';
import esI18n from './i18n/es.json';
import plI18n from './i18n/pl.json';
import ukI18n from './i18n/uk.json';
import zhCnI18n from './i18n/zh-cn.json';

export interface EnumItem {
    id: string;
    name: string;
}

interface AppState extends GenericAppState {
    residentsInstances: string[];
    allRooms: EnumItem[];
    allFunctions: EnumItem[];
    enumsLoaded: boolean;
}

function enumName(name: string | Record<string, string>): string {
    if (typeof name === 'string') return name;
    return name.de || name.en || Object.values(name)[0] || '';
}

class App extends GenericApp<GenericAppProps, AppState> {
    constructor(props: GenericAppProps) {
        const extendedProps: GenericAppSettings = {
            ...props,
            encryptedFields: [],
            translations: {
                en: enI18n,
                de: deI18n,
                ru: ruI18n,
                pt: ptI18n,
                nl: nlI18n,
                fr: frI18n,
                it: itI18n,
                es: esI18n,
                pl: plI18n,
                uk: ukI18n,
                'zh-cn': zhCnI18n,
            },
        };
        super(props, extendedProps);
        this.state = { ...this.state, residentsInstances: [], allRooms: [], allFunctions: [], enumsLoaded: false };
    }

    async onConnectionReady(): Promise<void> {
        try {
            const [roomEnums, funcEnums, resInstances] = await Promise.all([
                this.socket.getEnums('rooms'),
                this.socket.getEnums('functions'),
                this.socket.getAdapterInstances('residents'),
            ]);

            const toList = (enums: Record<string, any>): EnumItem[] =>
                Object.values(enums)
                    .map(e => ({ id: e._id, name: enumName(e.common.name) }))
                    .sort((a, b) => a.name.localeCompare(b.name));

            this.setState({
                allRooms: toList(roomEnums),
                allFunctions: toList(funcEnums),
                residentsInstances: resInstances.map(inst => inst._id.split('.').pop() as string),
                enumsLoaded: true,
            });
        } catch (e) {
            console.error('Hannah: failed to load enums', e);
            this.setState({ allRooms: [], allFunctions: [], residentsInstances: [], enumsLoaded: true });
        }
    }

    render(): React.JSX.Element {
        if (!this.state.loaded) {
            return super.render();
        }

        return (
            <div className="App">
                <Settings
                    native={this.state.native}
                    onChange={(attr, value) => this.updateNativeValue(attr, value)}
                    residentsInstances={this.state.residentsInstances}
                    allRooms={this.state.allRooms}
                    allFunctions={this.state.allFunctions}
                    enumsLoaded={this.state.enumsLoaded}
                />
                {this.renderError()}
                {this.renderToast()}
                {this.renderSaveCloseButtons()}
            </div>
        );
    }
}

export default App;
