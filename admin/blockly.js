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
