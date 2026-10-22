import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {defaultAgent} from './contracts.js';
import type {LocalStore} from './store.js';
import {localGit} from './git.js';
/** Reduced, deliberately defective example of Salem's structured-output validation. */
export async function createEvolutionDemo(store:LocalStore){
 const id=randomUUID(),root=join(store.root,'demos',id),settings=(await store.readState()).settings;await mkdir(root,{recursive:true});
 await writeFile(join(root,'AGENTS.md'),'# Demo de evolución de Salem\nEjemplo reducido de validación de salidas estructuradas. Solo modifica normalize.mjs. No cambies verificadores, permisos, configuración ni instrucciones. No ejecutes acciones Git, red o publicación.\n');
 await writeFile(join(root,'.gitattributes'),'* text eol=lf\n');
 await writeFile(join(root,'normalize.mjs'),"export function normalizeVerdict(value){return ['ready','needs_input','blocked'].includes(String(value)) ? String(value) : null;}\n");
 await writeFile(join(root,'.salem-check.mjs'),"import assert from 'node:assert/strict';import {normalizeVerdict} from './normalize.mjs';\nfor(const v of ['ready','needs_input','blocked'])assert.equal(normalizeVerdict(v),v,'conservar strings válidos');\nfor(const v of [['ready'],['blocked'],{},42,null,undefined,true])assert.equal(normalizeVerdict(v),null,'rechazar arrays y valores que no sean strings');\nassert.equal(normalizeVerdict('unknown'),null);console.log('Contrato original verificado: tipos estrictos y estados válidos');\n");
 await localGit(root,['init','--template=','-b','demo'],store.root);await localGit(root,['add','--all'],store.root);await localGit(root,['-c','user.name=Salem Demo','-c','user.email=demo@example.invalid','commit','-m','Demo de validación con defecto reproducible'],store.root);
 const project=await store.saveProject({name:'Demo · Evolución de Salem',baseRef:'HEAD',preparation:[],config:{schemaVersion:1,projectId:`evolution-demo-${id.slice(0,8)}`,repoRoot:root,contextFiles:['AGENTS.md'],agents:{codex:defaultAgent('codex',settings),claude:defaultAgent('claude',settings)},checks:[{id:'strict-verdict',command:[process.execPath,'.salem-check.mjs'],required:true}],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:180000,maxOutputBytes:2_000_000},supervisor:{roles:{define:'codex',build:'codex',review:'codex'},runTimeoutMs:600000,maxAttempts:3,maxReportedTokens:500000}}});
 const criteria=['Acepta exclusivamente los strings ready, needs_input y blocked','Rechaza arrays, objetos y otros tipos sin coerción'];
 const task=await store.saveTask({projectId:project.id,spec:{id:'SALEM-STRICT-VERDICT',objective:'Corrige normalizeVerdict en el ejemplo reducido del parser de Salem: solo strings válidos, sin coerción de arrays u otros tipos. Conserva la API, los verificadores y los criterios originales.',scope:['normalize.mjs'],acceptance:criteria,references:['AGENTS.md','normalize.mjs'],acceptanceChecks:Object.fromEntries(criteria.map(c=>[c,['strict-verdict']]))}});return {project,task};
}
