/**
 * The answer of the message "help": what the instance answers and which states an agent uses, written for an AI
 * agent (e.g. ioBroker.pi-agent, or the MCP server with `send_to`) and for script authors. Keep it in sync with
 * `onMessage` in main.ts and messages.ts.
 */

/** The commands the instance answers. write: true if the command has an effect (speaks, sends, changes, controls) */
export const COMMANDS: { command: string; write: boolean }[] = [
    { command: 'help', write: false },
    { command: 'announce', write: true },
    { command: 'ask', write: true },
    { command: 'sendDirect', write: true },
    { command: 'sendNotification', write: true },
    { command: 'getDiagnostics', write: false },
    { command: 'getFirmwareFiles', write: false },
    { command: 'provisionSatellite', write: true },
    { command: 'updateSatelliteNvs', write: true },
    { command: 'setSatelliteDisplayName', write: true },
    // answered by the device manager of @iobroker/dm-utils (deviceManager.ts)
    { command: 'dm:instanceInfo', write: false },
    { command: 'dm:loadDevices', write: false },
    { command: 'dm:deviceInfo', write: false },
    { command: 'dm:deviceStatus', write: false },
    { command: 'dm:deviceDetails', write: false },
    { command: 'dm:instanceAction', write: true },
    { command: 'dm:deviceAction', write: true },
    { command: 'dm:deviceControl', write: true },
    { command: 'dm:deviceControlState', write: false },
    { command: 'dm:deviceLoadProgress', write: false },
    { command: 'dm:actionProgress', write: true },
];

export const HELP = `ioBroker.hannah: connects ioBroker to Hannah, a local voice assistant with satellites (microphone and speaker in
the rooms). Hannah switches the devices of ioBroker by voice. An agent can let the satellites announce a text, ask a
resident a question and get the spoken answer, pass on a notification, or send Hannah a text command.
Rooms: the rooms of Hannah, as in hannah.0.satellites.rooms.<room>; "all" = every satellite.

Commands (sendTo hannah.0):
- announce {text, room?, rooms?, person?}: the satellites speak the text as it is (no rewording): {sent}.
  room (one) or rooms (a list), default "all". person: the roomie ID of the residents adapter (e.g. "leonie" of
  residents.0.roomie.leonie): only the satellites of that person (and only in room/rooms, if given).
  Errors: {sent: false, error: "no payload" or "unknown person '<id>'"}. Without person, sent true only means that
  it was passed on; whether Hannah Core is connected says the state info.connection.
- ask {text, room?}: a satellite in the room (default "all") asks the question and listens for the spoken answer:
  {answer}. The answer comes when somebody answered (no time limit of its own); {sent: false, error: "Hannah Core
  disconnected"} if the connection drops. No text: {sent: false, error: "no payload"}.
- sendDirect {text}: a notification to Hannah Core, spoken as it is (no rewording by the language model):
  {sent, error?}. Where Hannah delivers notifications is set in Hannah Core.
- sendNotification {category: {name, description, severity, instances: {<instance>: {messages: [{message}]}}}}:
  a notification as the notification-manager sends it; Hannah rewords it (severity alert, notify or info). The same
  notification is passed on once in 24 h, alerts always: {sent, error?}.
- getDiagnostics {selectedRooms?, selectedFunctions?, extraStatePrefixes?, prefixes?}: how Hannah understands the
  devices with these settings (enum IDs and state ID prefixes; not the saved settings: left out = all rooms, no
  function needed): {counts, devices: [{id, name, room, deviceClass, slots, findings: [{severity, text, fix}]}],
  notRead, other, notes}.
- provisionSatellite, updateSatelliteNvs, setSatelliteDisplayName, getFirmwareFiles and the device manager
  (dm:instanceInfo, dm:loadDevices, dm:deviceInfo, dm:deviceStatus, dm:deviceDetails, dm:instanceAction,
  dm:deviceAction, dm:deviceControl, dm:deviceControlState, dm:deviceLoadProgress, dm:actionProgress): for the
  settings, not for agents.

States (hannah.0.*), written with ack false:
- textCommand: Hannah handles the text like a spoken command (and switches devices for it); textAnswer: her answer.
- satellites.rooms.<room>.<satellite>.*: announcement (a text to speak), announcementSsml (SSML),
  announcementRephrase (a text the language model rewords first), volume (0-100), mute (the microphone), dnd (do
  not disturb), led_brightness (0-100), restart and update_now (true); read-only: online, owner, firmware_version,
  update_available.
- satellites.rooms.<room>.* and satellites.rooms.all.*: announcement, announcementSsml, announcementRephrase, dnd and
  mute for every satellite in the room (all: everywhere); anyOnline (read-only).
- info.connection: true while connected to Hannah Core.

How to talk to the user:
- Which room or satellite: the one the user names. If there are several and the user names none, ask; do not guess,
  and use "all" only when the user wants every room.
- Announce and ask only on the user's request; at night (about 22:00 to 07:00) and loud (volume above about 50)
  only when the user asks for it explicitly. An announcement for a person reaches that person: name them first.
- textCommand acts like a voice command: only with the text the user wants.
- restart, update_now, mute, dnd and volume change the satellites: only on the user's request.
- Name rooms and satellites by their names, not by IDs.`;
