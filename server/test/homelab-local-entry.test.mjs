import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import express from 'express';
import {installAuth} from '../auth.mjs';

test('an explicitly allowed Docker peer gets local viewing only on the local entry and configured host',t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-docker-peer-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const make=networks=>installAuth(express(),{directory,publicDirectory:path.resolve('public'),localPort:8082,localHosts:['localhost','192.168.50.12'],localNetworks:networks});
	const request=(port=8082,hostname='localhost',headers={})=>({socket:{localPort:port,remoteAddress:'::ffff:192.168.65.1'},hostname,headers});
	assert.equal(make([]).isLocal(request()),false);
	const configured=make(['192.168.65.1/32']);
	assert.equal(configured.isLocal(request()),true);
	assert.equal(configured.isLocal(request(8082,'192.168.50.12')),true);
	assert.equal(configured.isLocal(request(8083)),false);
	assert.equal(configured.isLocal(request(8082,'public.example.test')),false);
	assert.equal(configured.isLocal(request(8082,'localhost',{'x-forwarded-for':'192.168.50.20'})),false);
});
