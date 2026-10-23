import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codexFailureMessage} from '../src/adapters/codex.js';

test('Codex account model refusal is unwrapped and explains how to select a supported model',()=>{
 const message="The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
 const nested=JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message}});
 const stdout=JSON.stringify({type:'turn.failed',error:{message:nested}});
 const error=codexFailureMessage(stdout)!;
 assert.ok(error.includes(message));assert.match(error,/Predeterminado del CLI/);assert.match(error,/Proyectos/);
 assert.equal(error.includes('invalid_request_error'),false,'show the actionable reason instead of a serialized envelope');
 assert.ok(error.length<=800);
});

test('Codex warning events alone are not interpreted as a failed turn',()=>{
 assert.equal(codexFailureMessage(JSON.stringify({type:'item.completed',item:{type:'error',message:'Unknown model metadata; using fallback metadata'}})),null);
});

test('unrelated Codex failures keep their reason without model advice',()=>{
 assert.equal(codexFailureMessage(JSON.stringify({type:'turn.failed',error:{message:'Network unavailable'}})),'Codex: Network unavailable');
});
