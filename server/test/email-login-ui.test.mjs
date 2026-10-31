import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('pending request keeps the email form visible until an approved visitor asks for a code', async () => {
	const button={disabled:false,textContent:'Continue'},input={value:'guest@example.test',focus(){}},message={textContent:''};
	const form={hidden:true,elements:{email:input,remember:{checked:true}},querySelector:()=>button};
	const codeButton={disabled:false};
	const code={hidden:true,elements:{code:{value:'12345678',focus(){}}},querySelector:()=>codeButton,reset(){}};
	const pending={hidden:true},checkButton={},heading={},another={},description={},note={},loginForm={hidden:false},calls=[];
	const nodes={'#approvalPending':pending,'#pendingEmail':{},'#checkApproval':checkButton,'#changePendingEmail':{},'.auth-card h1':heading,'#emailLogin':form,'#emailCode':code,'#anotherCode':another,'.auth-description':description,'.auth-note':note};
	let approved=false;
	const context={loginForm,authMessage:message,document:{querySelector:s=>nodes[s]},location:{replace(){}},clearInterval(){},setInterval(){throw Error('No polling should send a code');},authRequest:async (url,body)=>{
		calls.push({url,body});
		if(url.endsWith('/me'))return {status:'signed-out'};
		if(url.endsWith('/code'))return approved?{status:'code-sent',challenge:'test-challenge'}:{status:'pending'};
		if(url.endsWith('/verify'))return {status:'approved'};
		throw Error('Unexpected request');
	}};
	const source=readFileSync(new URL('../public/auth.js',import.meta.url),'utf8');
	vm.runInNewContext(source.slice(source.indexOf('function setupEmailLogin()'))+';setupEmailLogin();',context);
	await new Promise(resolve=>setImmediate(resolve));
	await form.onsubmit({preventDefault(){}});
	assert.equal(form.hidden,true);assert.equal(pending.hidden,false);assert.equal(code.hidden,true);assert.equal(heading.textContent,'Waiting for approval');
	assert.match(message.textContent,/awaiting approval/);
	assert.equal(calls.filter(c=>c.url.endsWith('/code')).length,1);
	approved=true;await checkButton.onclick();
	assert.equal(form.hidden,true);assert.equal(code.hidden,false);assert.match(message.textContent,/eight-digit code/);
	await code.onsubmit({preventDefault(){}});
	const verify=calls.find(c=>c.url.endsWith('/verify'));assert.equal(verify.body.challenge,'test-challenge');assert.equal(verify.body.name,undefined);
	another.onclick();assert.equal(form.hidden,false);assert.equal(code.hidden,true);assert.equal(button.textContent,'Continue');
});
