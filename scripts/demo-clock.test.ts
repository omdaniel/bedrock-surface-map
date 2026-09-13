import {test} from "node:test";
import assert from "node:assert/strict";
import {DemoClock} from "../web/src/demo-clock.ts";
test("two complete loops, restart, pause and hidden clock retain monotonic revisions",()=>{
 const c=new DemoClock(); c.update(100); c.running=true;
 let rev=0;
 for(let t=100;t<=120100;t+=1000){c.update(t);assert.ok(c.revision>=rev);rev=c.revision;}
 assert.equal(c.stage,0); assert.equal(c.phase,0); assert.equal(c.revision,9);
 c.restart(120100); assert.ok(c.revision>rev);
 c.running=false;c.update(150100);assert.equal(c.phase,0);
 c.running=true;c.hidden=true;c.update(180100);assert.equal(c.phase,0);
 c.hidden=false;c.update(182100);assert.equal(c.phase,2000);
});
