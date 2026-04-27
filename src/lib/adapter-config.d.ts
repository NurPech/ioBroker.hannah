// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            hannahHost: string;
            hannahPort: number;
            enumFunctions: string;
            enumRooms: string;
            extraStatePrefixes: Array<{ prefix: string }>;
            residentsStatePrefix: string;
            residentsGuestPrefix: string;
            residentsStateKey: string;
            textCommandStateId: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};