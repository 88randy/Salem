import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultAgent, defaultSettings } from '../src/local/contracts.js';
import * as models from '../src/model-presets.js';

test('new agents propose explicit editable models without changing configured command arguments', () => {
 const settings=defaultSettings();
 const codex=defaultAgent('codex',settings);
 assert.equal(codex.model,'gpt-6.1-sol');
 assert.equal(codex.effort,undefined);
 assert.deepEqual(codex.command,settings.commands.codex);
 assert.notEqual(codex.command,settings.commands.codex);
 const claude=defaultAgent('claude',settings);
 assert.equal(claude.model,'claude-opus-5-5');
 assert.equal(claude.effort,'medium');
 assert.deepEqual(claude.command,settings.commands.claude);
});

test('changing provider clears incompatible model and effort and proposes the new provider default', () => {
 const change = (models as Record<string,unknown>).changeAgentProvider;
 assert.equal(typeof change,'function','provider selection must reset model configuration');
 if(typeof change!=='function') return;
 const original={provider:'codex' as const,command:['custom-codex'],model:'imported-codex-model',effort:'xhigh',ignoreUserConfig:true};
 assert.deepEqual(change(original,'claude',['custom-claude']),{provider:'claude',command:['custom-claude'],model:'claude-opus-5-5',effort:'medium'});
 const back=change({provider:'claude',command:['claude'],model:'unknown-import',effort:'max'},'codex',['custom-codex']);
 assert.deepEqual(back,{provider:'codex',command:['custom-codex'],model:'gpt-6.1-sol',ignoreUserConfig:true});
 assert.equal(original.model,'imported-codex-model');
 assert.equal(change(original,'codex',['other']),original,'editing existing profiles must not silently rewrite model selections');
});
