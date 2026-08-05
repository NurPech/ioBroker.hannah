// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            hannahHost: string;
            hannahPort: number;
            selectedRooms: string[];
            selectedFunctions: string[];
            extraStatePrefixes: Array<{ prefix: string }>;
            floorMappings: Array<{ label: string; abbreviation: string }>;
            residentsInstance: string;
            weatherAdapterType: string;
            weatherInstance: string;
            weatherCustomMapping: {
                temperature?: string;
                humidity?: string;
                conditionText?: string;
                precipitationMm?: string;
                windSpeedMs?: string;
                windDirectionText?: string;
            };
            firmwareSourceUrl: string;
            firmwareSourceToken: string;
            satWifiSsid: string;
            satWifiPass: string;
            satMqttBroker: string;
            satMqttPort: string;
            satMqttUser: string;
            satMqttPass: string;
            satOtaUrl: string;
            satOtaChannel: string;
            satOtaToken: string;
            satAssetUrl: string;
            satAssetToken: string;
            satNvsToken: string;
            satTlsSkipVerify: boolean;
            adminUserId: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};