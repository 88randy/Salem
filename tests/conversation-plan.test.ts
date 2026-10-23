import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkGraph, orderedWork} from '../src/local/conversation-plan.js';
const task=(id:string,dependsOn:string[]=[])=>({id,title:id,objective:'Implementar '+id,scope:['sum.mjs'],acceptance:['Funciona'],checkIds:['sum'],dependsOn,agentId:'codex'});
test('graph orders dependencies and rejects cycles, unknown checks/agents and duplicate IDs',()=>{
 const graph=parseWorkGraph({tasks:[task('three',['two']),task('one'),task('two',['one'])]},['sum'],['codex']);
 assert.deepEqual(orderedWork(graph).map(t=>t.id),['one','two','three']);
 for(const tasks of [[task('one'),task('one')],[task('one',['missing'])],[task('one',['two']),task('two',['one'])]])assert.throws(()=>parseWorkGraph({tasks},['sum'],['codex']));
 assert.throws(()=>parseWorkGraph({tasks:[task('one')]},[],['codex']));
 assert.throws(()=>parseWorkGraph({tasks:[task('one')]},['sum'],['claude']));
 assert.throws(()=>parseWorkGraph({tasks:[{...task('one'),scope:['../outside']}]},['sum'],['codex']));
});
