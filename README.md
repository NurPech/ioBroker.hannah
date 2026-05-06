![Logo](admin/hannah.png)
# ioBroker.hannah

[![NPM version](https://img.shields.io/npm/v/iobroker.hannah.svg)](https://www.npmjs.com/package/iobroker.hannah)
[![Downloads](https://img.shields.io/npm/dm/iobroker.hannah.svg)](https://www.npmjs.com/package/iobroker.hannah)
**Tests:** ![Test and Release](https://github.com/NurPech/ioBroker.hannah/workflows/Test%20and%20Release/badge.svg)

## Hannah adapter for ioBroker

Connects ioBroker to the [Hannah](https://github.com/NurPech/hannah) voice assistant via a bidirectional gRPC stream. Device states, presence information and text commands flow from ioBroker to Hannah in real time; Hannah sends SetState commands back when it controls devices.

This adapter replaces the previous MQTT-based integration and eliminates the message-loop problems that came with retained topics and wildcard subscriptions.

## Features

- **Bidirectional gRPC stream** — persistent connection with automatic reconnect
- **Device discovery** via ioBroker enums (rooms × functions) with configurable filters
- **Extra state prefixes** — subscribe to any additional state tree (e.g. car tracker, weather adapter)
- **Snapshot on connect** — current state values are pushed to Hannah immediately after connecting, replacing MQTT retained messages
- **Resident presence** — forwards presence state changes from the Residents adapter
- **Text commands** — write to `hannah.<instance>.textCommand` to send text queries to Hannah
- **SetState** — Hannah can set ioBroker states directly via the same gRPC channel
- **Notifications** — forward messages to Hannah via `sendTo` or the native ioBroker Notification Manager; LLM reformulation for system messages, direct TTS for `sendDirect`
- **Announcements** — play TTS in specific satellite rooms via `sendTo` with a room list, without LLM or Telegram
- **Blockly support** — custom blocks for direct messages and room announcements

## Requirements

- ioBroker js-controller ≥ 5.0
- Node.js ≥ 20
- A running [Hannah Core](https://github.com/NurPech/hannah) instance with gRPC enabled (default port 50051)

## Installation

Install via the ioBroker admin interface

## Configuration

### Connection tab

| Field | Description | Default |
|-------|-------------|---------|
| Hannah Host | IP address or hostname of the Hannah Core server | `127.0.0.1` |
| gRPC Port | Port Hannah Core listens on | `50051` |

### Device Discovery tab

Select which **rooms** and **functions** Hannah should be aware of. Leaving both lists empty includes everything.

**Extra State Prefixes** — additional ioBroker state ID prefixes to stream to Hannah, e.g.:

| Use case | Prefix |
|----------|--------|
| Car tracker (VW-Connect) | `javascript.0.virtualDevice.Auto` |
| Weather (openweathermap adapter) | `openweathermap.0.forecast` |
| User variables | `0_userdata.0` |

### Integrations tab

| Field | Description |
|-------|-------------|
| Residents Adapter Instance | Instance number of the Residents adapter for presence tracking |

## Adapter states

| State | Type | Description |
|-------|------|-------------|
| `hannah.<instance>.info.connection` | boolean | `true` while connected to Hannah Core |
| `hannah.<instance>.textCommand` | string | Write a text query here (ack=false) to send it to Hannah |

## Hannah Core configuration

The adapter expects `HannahService.AgentConnect` to be available on the configured host/port. No additional Hannah-side configuration is required — the adapter identifies itself automatically on connect.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* New: `AgentDevice` proto carries a `device_type` field (field 5) — resolved from `common.hannah.type` override, ioBroker role (e.g. `level.temperature` → `thermostat`, `sensor.window` → `window`), or function enum IDs; supported types: `light`, `socket`, `thermostat`, `temperature_sensor`, `window`, `door`, `blind`

### 0.4.2 (2026-05-04)
* Fixed: automated TypeScript build via GitHub Actions

### 0.4.1 (2026-05-04)
* Fixed: Deployment Issues. Not all required files where inside the package

### 0.4.0 (2026-05-03)
* Fixed: States may only be set if the state is writable (`common.write === true`).
* New: `AgentDevice` now includes a `floor` field — resolved from `common.floor` on the device object, with a fallback that scans the state ID path for known floor abbreviations (EG, OG, UG, DG, KG, ZG).
* New: Configurable floor mappings — define custom label→abbreviation pairs in the Device Discovery tab (e.g. "Erdgeschoss" → "EG"); mappings normalize both `common.floor` values and ID path segments, and extend (not replace) the built-in abbreviation set.

### 0.3.2 (2026-05-03)
* Fixed: Device names in Telegram and Hannah were showing the full state ID instead of the readable name

### 0.3.1 (2026-05-02)
* Fixed: The adapter sends too much data to Hannah

### 0.3.0 (2026-05-02)

* New: Device snapshot on connect — the adapter now sends room, device name, function and current value for every subscribed state immediately after connecting, so Hannah Core no longer needs to query the ioBroker REST API for device discovery
* New: Resident snapshot on connect — all known residents are forwarded to Hannah Core once after connecting, replacing the previous API-based resident lookup
* New: `AgentDevice` proto message carries full metadata (room, device, functions, current value) per state; `AgentDeviceSnapshot` wraps the complete list
* Improved: Enum lookups during snapshot are now fetched once and reused across all states instead of once per state, significantly reducing startup time for large installations

### 0.2.1 (2026-05-01)
* Fixed: Hannah could set any state. That could be a security Issue. Hannah can now only edit the states that the adapter actively manages.

### 0.2.0 (2026-04-30)

* New: Send direct messages to Hannah via `sendTo('hannah.<instance>', 'sendDirect', { text: '...' })` — plays via TTS on all satellites and forwards to Telegram, no LLM involved
* New: Native ioBroker Notification Manager integration — system notifications are automatically forwarded to Hannah and reformulated by the LLM before being spoken and sent to Telegram
* New: Announcements via `sendTo('hannah.<instance>', 'announce', { rooms: ['Wohnzimmer', 'Küche'], text: '...' })` — plays TTS in specific rooms only, bypasses LLM and Telegram. Use `rooms: ['all']` to address every satellite
* New: Blockly block **"Hannah say"** for direct voice messages
* New: Blockly block **"Hannah announce"** with a list input for target rooms
* Fixed: Duplicate gRPC connections on reconnect — old stream is now properly closed before opening a new one
* Fixed: `prepublishOnly` instead of `prepack` — installing the adapter locally no longer triggers a full build

### 0.1.0 (2026-04-30)
* New: Native AgentTextAnswer via gRPC pushes responses directly to hannah.<instance>.textAnswer
* New: Dedicated resident_set gRPC command for residents.set_presence() to eliminate the final MQTT dependency
* New: Satellite state management integrated into adapter via GetSatellites() and gRPC subscriptions (NotifySatelliteRegistered/Gone)
* New: Automatic satellite state initialization under hannah.<instance>.satellites.* at startup
* Fixed: Removed redundant residentsPrefix from StateWatcher to prevent duplicate state_update transmissions
* Fixed: Consolidated resident tracking into ResidentsWatcher for a single, clean telemetry path
* Fixed: Replaced legacy JavaScript satellite/room logic with native adapter functionality
* Fixed: Full deprecation of the ioBroker-to-Hannah MQTT feedback channel in favor of gRPC streams

### 0.0.2 (2026-04-28)
* Fixed: ControlDevice feedback channel — device state updates correctly after Hannah sets a state
* Fixed: Wildcard pattern matching for subscribed states
* Fixed: Resident presence subscription restricted to configured instance
* Fixed: Only forward confirmed states (ack=true) to Hannah; commands (ack=false) are ignored
* New: Text command state moved into adapter namespace (`hannah.<instance>.textCommand`)
* New: Automatic reloading of enum subscriptions when rooms or functions change in ioBroker

### 0.0.1 (2026-04-27)
* Initial release
* Bidirectional gRPC stream (state updates, resident presence, text commands, SetState)
* Enum-based device discovery with room × function filtering
* Extra state prefix support for arbitrary state trees
* Snapshot-on-connect replaces MQTT retained messages

## License

MIT License

Copyright (c) 2026 M1kad0 <leonie+iobroker@sgessinger.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
