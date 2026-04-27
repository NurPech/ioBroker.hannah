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
- **Text commands** — a configurable ioBroker state can be used to send text queries to Hannah
- **SetState** — Hannah can set ioBroker states directly via the same gRPC channel

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
| Text Command State ID | ioBroker state ID to watch for text queries sent to Hannah |

## Hannah Core configuration

The adapter expects `HannahService.AgentConnect` to be available on the configured host/port. No additional Hannah-side configuration is required — the adapter identifies itself automatically on connect.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
Bug: ControlDevice-Rückkanal defekt

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
