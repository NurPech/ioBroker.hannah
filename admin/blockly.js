/* eslint-disable no-undef */
'use strict';

if (typeof goog !== 'undefined') {
    goog.provide('Blockly.JavaScript.Sendto');
    goog.require('Blockly.JavaScript');
}

Blockly.Translate =
    Blockly.Translate ||
    function (word, lang) {
        lang = lang || systemLang;
        if (Blockly.Words && Blockly.Words[word]) {
            return Blockly.Words[word][lang] || Blockly.Words[word].en;
        }
        return word;
    };

// --- Hannah sendDirect -----------------------------------------------------------

Blockly.Words['hannah-send-direct'] = {
    en: 'Hannah say',
    de: 'Hannah sagen',
};
Blockly.Words['hannah-send-direct_text'] = {
    en: 'Text',
    de: 'Text',
};
Blockly.Words['hannah-send-direct_anyInstance'] = {
    en: 'All instances',
    de: 'Alle Instanzen',
};
Blockly.Words['hannah-send-direct_help'] = {
    en: 'https://github.com/NurPech/ioBroker.hannah',
    de: 'https://github.com/NurPech/ioBroker.hannah',
};

Blockly.Sendto.blocks['hannah-send-direct'] =
    '<block type="hannah-send-direct">' +
    '  <field name="INSTANCE"></field>' +
    '  <value name="TEXT">' +
    '    <shadow type="text">' +
    '      <field name="TEXT">Text</field>' +
    '    </shadow>' +
    '  </value>' +
    '</block>';

Blockly.Blocks['hannah-send-direct'] = {
    init: function () {
        const options = [];

        if (typeof main !== 'undefined' && main.instances) {
            for (let i = 0; i < main.instances.length; i++) {
                const m = main.instances[i].match(/^system.adapter.hannah.(\d+)$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    options.push([`hannah.${n}`, `.${n}`]);
                }
            }
        }

        if (!options.length) {
            for (let k = 0; k <= 4; k++) {
                options.push([`hannah.${k}`, `.${k}`]);
            }
        }

        options.unshift([Blockly.Translate('hannah-send-direct_anyInstance'), '']);

        this.appendDummyInput('INSTANCE')
            .appendField(Blockly.Translate('hannah-send-direct'))
            .appendField(new Blockly.FieldDropdown(options), 'INSTANCE');

        this.appendValueInput('TEXT').appendField(Blockly.Translate('hannah-send-direct_text'));

        this.setInputsInline(false);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(Blockly.Sendto.HUE);
        this.setHelpUrl(Blockly.Translate('hannah-send-direct_help'));
    },
};

Blockly.JavaScript['hannah-send-direct'] = function (block) {
    const instance = block.getFieldValue('INSTANCE');
    const text = Blockly.JavaScript.valueToCode(block, 'TEXT', Blockly.JavaScript.ORDER_ATOMIC);

    return `sendTo('hannah${instance}', 'sendDirect', { text: ${text} });\n`;
};

// --- Hannah announce -------------------------------------------------------------

Blockly.Words['hannah-announce'] = { en: 'Hannah announce', de: 'Hannah Ansage' };
Blockly.Words['hannah-announce_room'] = { en: 'Room', de: 'Raum' };
Blockly.Words['hannah-announce_text'] = { en: 'Text', de: 'Text' };
Blockly.Words['hannah-announce_anyInstance'] = { en: 'All instances', de: 'Alle Instanzen' };
Blockly.Words['hannah-announce_help'] = {
    en: 'https://github.com/NurPech/ioBroker.hannah',
    de: 'https://github.com/NurPech/ioBroker.hannah',
};

Blockly.Sendto.blocks['hannah-announce'] =
    '<block type="hannah-announce">' +
    '  <field name="INSTANCE"></field>' +
    '  <value name="ROOMS">' +
    '    <block type="lists_create_with"><mutation items="1"></mutation></block>' +
    '  </value>' +
    '  <value name="TEXT">' +
    '    <shadow type="text">' +
    '      <field name="TEXT">Text</field>' +
    '    </shadow>' +
    '  </value>' +
    '</block>';

Blockly.Blocks['hannah-announce'] = {
    init: function () {
        const options = [];

        if (typeof main !== 'undefined' && main.instances) {
            for (let i = 0; i < main.instances.length; i++) {
                const m = main.instances[i].match(/^system.adapter.hannah.(\d+)$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    options.push([`hannah.${n}`, `.${n}`]);
                }
            }
        }

        if (!options.length) {
            for (let k = 0; k <= 4; k++) {
                options.push([`hannah.${k}`, `.${k}`]);
            }
        }

        options.unshift([Blockly.Translate('hannah-announce_anyInstance'), '']);

        this.appendDummyInput('INSTANCE')
            .appendField(Blockly.Translate('hannah-announce'))
            .appendField(new Blockly.FieldDropdown(options), 'INSTANCE');

        this.appendValueInput('ROOMS').appendField(Blockly.Translate('hannah-announce_room'));

        this.appendValueInput('TEXT').appendField(Blockly.Translate('hannah-announce_text'));

        this.setInputsInline(false);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(Blockly.Sendto.HUE);
        this.setHelpUrl(Blockly.Translate('hannah-announce_help'));
    },
};

Blockly.JavaScript['hannah-announce'] = function (block) {
    const instance = block.getFieldValue('INSTANCE');
    const rooms = Blockly.JavaScript.valueToCode(block, 'ROOMS', Blockly.JavaScript.ORDER_ATOMIC) || "['all']";
    const text = Blockly.JavaScript.valueToCode(block, 'TEXT', Blockly.JavaScript.ORDER_ATOMIC);

    return `sendTo('hannah${instance}', 'announce', { rooms: ${rooms}, text: ${text} });\n`;
};

// --- Hannah ask ------------------------------------------------------------------

Blockly.Words['hannah-ask'] = { en: 'Ask resident', de: 'Bewohner fragen' };
Blockly.Words['hannah-ask_room'] = { en: 'Room', de: 'Raum' };
Blockly.Words['hannah-ask_text'] = { en: 'Question', de: 'Frage' };
Blockly.Words['hannah-ask_do'] = { en: 'with answer in', de: 'mit Antwort in' };
Blockly.Words['hannah-ask_anyInstance'] = { en: 'All instances', de: 'Alle Instanzen' };
Blockly.Words['hannah-ask_help'] = {
    en: 'https://github.com/NurPech/ioBroker.hannah',
    de: 'https://github.com/NurPech/ioBroker.hannah',
};

Blockly.Sendto.blocks['hannah-ask'] =
    '<block type="hannah-ask">' +
    '  <field name="INSTANCE"></field>' +
    '  <value name="ROOM">' +
    '    <shadow type="text"><field name="TEXT">all</field></shadow>' +
    '  </value>' +
    '  <value name="TEXT">' +
    '    <shadow type="text"><field name="TEXT"></field></shadow>' +
    '  </value>' +
    '</block>';

Blockly.Blocks['hannah-ask'] = {
    init: function () {
        const options = [];

        if (typeof main !== 'undefined' && main.instances) {
            for (let i = 0; i < main.instances.length; i++) {
                const m = main.instances[i].match(/^system.adapter.hannah.(\d+)$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    options.push([`hannah.${n}`, `.${n}`]);
                }
            }
        }

        if (!options.length) {
            for (let k = 0; k <= 4; k++) {
                options.push([`hannah.${k}`, `.${k}`]);
            }
        }

        options.unshift([Blockly.Translate('hannah-ask_anyInstance'), '']);

        this.appendDummyInput('INSTANCE')
            .appendField(Blockly.Translate('hannah-ask'))
            .appendField(new Blockly.FieldDropdown(options), 'INSTANCE');

        this.appendValueInput('ROOM').appendField(Blockly.Translate('hannah-ask_room'));
        this.appendValueInput('TEXT').appendField(Blockly.Translate('hannah-ask_text'));
        this.appendStatementInput('DO')
            .appendField(Blockly.Translate('hannah-ask_do'))
            .appendField(new Blockly.FieldVariable('answer'), 'VAR');

        this.setInputsInline(false);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(Blockly.Sendto.HUE);
        this.setHelpUrl(Blockly.Translate('hannah-ask_help'));
    },
};

Blockly.JavaScript['hannah-ask'] = function (block) {
    const instance = block.getFieldValue('INSTANCE');
    const room = Blockly.JavaScript.valueToCode(block, 'ROOM', Blockly.JavaScript.ORDER_ATOMIC) || "'all'";
    const text = Blockly.JavaScript.valueToCode(block, 'TEXT', Blockly.JavaScript.ORDER_ATOMIC);
    const varName = block.getField('VAR').getText();
    const statements = Blockly.JavaScript.statementToCode(block, 'DO');

    return `sendTo('hannah${instance}', 'ask', { room: ${room}, text: ${text} }, function(result) {\n    var ${varName} = result.answer;\n${statements}});\n`;
};
