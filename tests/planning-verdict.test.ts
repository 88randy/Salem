import {test} from "node:test";
import assert from "node:assert/strict";
import {parseGoalPlan} from "../src/local/planning.js";
test("planning rejects non-string verdict lookalikes before persisting a goal state",()=>{
 const blocked={schemaVersion:1,verdict:"blocked",summary:"Falta contexto",facts:[],assumptions:[],decisions:[],questions:[],steps:[],task:{objective:"",scope:[],acceptance:[],references:[],checkIds:[]},proposedChecks:[]};
 assert.equal(parseGoalPlan(blocked,[],[]).verdict,"blocked");
 for(const verdict of [["ready"],["blocked"],["needs_input"],null,0,{}])assert.throws(()=>parseGoalPlan({...blocked,verdict},[],[]),/estado|plan|inválid/i);
});
