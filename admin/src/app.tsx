import React from 'react';
import { GenericApp } from '@iobroker/gui-components';
import type { GenericAppProps, GenericAppSettings, GenericAppState } from '@iobroker/gui-components';
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

/** A single enum entry with id and display name. */
export interface EnumItem {
    /** Full ioBroker enum ID, e.g. enum.rooms.Schlafzimmer */
    id: string;
    /** Display name resolved from the enum's common.name */
    name: string;
}

/** ioBroker weather adapters the "known adapter" role-scan supports. */
const WEATHER_ADAPTER_TYPES = ['openweathermap', 'accuweather', 'daswetter'] as const;

interface AppState extends GenericAppState {
    residentsInstances: string[];
    weatherInstancesByType: Record<string, string[]>;
    allRooms: EnumItem[];
    allFunctions: EnumItem[];
    enumsLoaded: boolean;
}

/**
 * Resolves a multilingual or plain string enum name to a display string.
 *
 * @param name - The enum common.name value (string or language map)
 */
function enumName(name: string | Record<string, string>): string {
    if (typeof name === 'string') {
        return name;
    }
    return name.de || name.en || Object.values(name)[0] || '';
}

/** Root application component for the Hannah adapter admin UI. */
class App extends GenericApp<GenericAppProps, AppState> {
    /** @inheritdoc */
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
        this.state = {
            ...this.state,
            residentsInstances: [],
            weatherInstancesByType: {},
            allRooms: [],
            allFunctions: [],
            enumsLoaded: false,
        };
    }

    /** @inheritdoc */
    async onConnectionReady(): Promise<void> {
        try {
            const [roomEnums, funcEnums, resInstances, ...weatherInstanceLists] = await Promise.all([
                this.socket.getEnums('rooms'),
                this.socket.getEnums('functions'),
                this.socket.getAdapterInstances('residents'),
                ...WEATHER_ADAPTER_TYPES.map(type => this.socket.getAdapterInstances(type)),
            ]);

            const toList = (enums: Record<string, any>): EnumItem[] =>
                Object.values(enums)
                    .map(e => ({ id: e._id, name: enumName(e.common.name) }))
                    .sort((a, b) => a.name.localeCompare(b.name));

            const weatherInstancesByType: Record<string, string[]> = {};
            WEATHER_ADAPTER_TYPES.forEach((type, i) => {
                weatherInstancesByType[type] = weatherInstanceLists[i].map(inst => inst._id.split('.').pop() as string);
            });

            this.setState({
                allRooms: toList(roomEnums),
                allFunctions: toList(funcEnums),
                residentsInstances: resInstances.map(inst => inst._id.split('.').pop() as string),
                weatherInstancesByType,
                enumsLoaded: true,
            });
        } catch (e) {
            console.error('Hannah: failed to load enums', e);
            this.setState({
                allRooms: [],
                allFunctions: [],
                residentsInstances: [],
                weatherInstancesByType: {},
                enumsLoaded: true,
            });
        }
    }

    /** @inheritdoc */
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
                    weatherInstancesByType={this.state.weatherInstancesByType}
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
