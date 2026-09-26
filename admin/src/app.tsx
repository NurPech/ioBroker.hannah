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

/** A daswetter location channel with its place name. */
export interface WeatherLocation {
    /** Location channel, e.g. location_1 */
    id: string;
    /** Place name from the channel's Location state */
    name: string;
}

interface AppState extends GenericAppState {
    residentsInstances: string[];
    weatherInstancesByType: Record<string, string[]>;
    daswetterLocations: Record<string, WeatherLocation[]>;
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
            daswetterLocations: {},
            allRooms: [],
            allFunctions: [],
            enumsLoaded: false,
        };
    }

    /** Collects daswetter.<instance>.location_N.Location states into per-instance location lists. */
    private async loadDaswetterLocations(): Promise<Record<string, WeatherLocation[]>> {
        const states = await this.socket.getForeignStates('daswetter.*.location_*.Location');
        const byInstance: Record<string, WeatherLocation[]> = {};
        for (const [id, state] of Object.entries(states || {}) as Array<[string, { val?: unknown } | null]>) {
            const m = id.match(/^daswetter\.(\d+)\.(location_\d+)\.Location$/);
            if (!m) {
                continue;
            }
            (byInstance[m[1]] ||= []).push({ id: m[2], name: state?.val ? String(state.val) : m[2] });
        }
        for (const list of Object.values(byInstance)) {
            list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
        }
        return byInstance;
    }

    /** @inheritdoc */
    async onConnectionReady(): Promise<void> {
        try {
            const [roomEnums, funcEnums, resInstances, daswetterLocations, ...weatherInstanceLists] =
                await Promise.all([
                    this.socket.getEnums('rooms'),
                    this.socket.getEnums('functions'),
                    this.socket.getAdapterInstances('residents'),
                    this.loadDaswetterLocations(),
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
                daswetterLocations,
                enumsLoaded: true,
            });
        } catch (e) {
            console.error('Hannah: failed to load enums', e);
            this.setState({
                allRooms: [],
                allFunctions: [],
                residentsInstances: [],
                weatherInstancesByType: {},
                daswetterLocations: {},
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
                    daswetterLocations={this.state.daswetterLocations}
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
