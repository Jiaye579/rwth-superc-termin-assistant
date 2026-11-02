const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {buildRelease}=require('../tools/build-release.cjs');
const RUNTIME=['adapter.js','alert.wav','background.js','content.js','core.js','diagnostics.js','icon.png','manifest.json','offscreen.html','offscreen.js','options.css','options.html','options.js','sound.js'];
const EXPECTED=[...RUNTIME.map(name=>'extension/'+name),'README.zh-CN.txt','安装说明.html'];
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'termin-release-test-'));
  t.after(()=>{
    const target=path.resolve(root),parent=path.resolve(os.tmpdir());
    if(!path.isAbsolute(target)||path.dirname(target)!==parent||!path.basename(target).startsWith('termin-release-test-'))throw new Error('Unsafe test cleanup target.');
    fs.rmSync(target,{recursive:true,force:true});
  });
  fs.mkdirSync(path.join(root,'extension'));
  for(const name of RUNTIME)fs.writeFileSync(path.join(root,'extension',name),name==='manifest.json'?JSON.stringify({manifest_version:3,name:'Fixture',version:'0.3.1'}):Buffer.from('SYNTHETIC RUNTIME '+name+'\n'));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'release-test',version:'0.3.1'}));
  fs.writeFileSync(path.join(root,'README.zh-CN.txt'),'虚构安装说明\n');fs.writeFileSync(path.join(root,'安装说明.html'),'<!doctype html><p>测试安装说明</p>\n');
  return root;
}
function crc(bytes) {
  let result=0xffffffff;
  for(const value of bytes){result^=value;for(let i=0;i<8;i++)result=(result>>>1)^((result&1)?0xedb88320:0);}
  return (result^0xffffffff)>>>0;
}
// Independent reader: checks central-directory metadata against each local
// header, inflates the payload, and validates size and CRC before returning it.
function readZip(bytes) {
  const end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);assert.equal(bytes.readUInt16LE(end+20),0);
  assert.equal(bytes.readUInt16LE(end+4),0);assert.equal(bytes.readUInt16LE(end+6),0);
  const count=bytes.readUInt16LE(end+10);assert.equal(bytes.readUInt16LE(end+8),count);
  let cursor=bytes.readUInt32LE(end+16),localEnd=0;const centralEnd=cursor+bytes.readUInt32LE(end+12),files=new Map();assert.equal(centralEnd,end);
  for(let i=0;i<count;i++) {
    assert.equal(bytes.readUInt32LE(cursor),0x02014b50);assert.equal(bytes.readUInt16LE(cursor+8),0x0800);assert.equal(bytes.readUInt16LE(cursor+10),8);
    assert.equal(bytes.readUInt16LE(cursor+12),0);assert.equal(bytes.readUInt16LE(cursor+14),0x21);
    const checksum=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    assert.equal(extraLength,0);assert.equal(commentLength,0);assert.equal(bytes.readUInt16LE(cursor+34),0);
    assert.equal((bytes.readUInt32LE(cursor+38)>>>16)&0xf000,0x8000);
    const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');assert.equal(files.has(name),false);
    assert.equal(offset,localEnd);assert.equal(bytes.readUInt32LE(offset),0x04034b50);assert.equal(bytes.readUInt16LE(offset+6),0x0800);assert.equal(bytes.readUInt16LE(offset+8),8);
    assert.equal(bytes.readUInt16LE(offset+10),0);assert.equal(bytes.readUInt16LE(offset+12),0x21);
    assert.equal(bytes.readUInt32LE(offset+14),checksum);assert.equal(bytes.readUInt32LE(offset+18),compressed);assert.equal(bytes.readUInt32LE(offset+22),size);
    assert.equal(bytes.readUInt16LE(offset+26),nameLength);assert.equal(bytes.readUInt16LE(offset+28),0);
    assert.equal(bytes.subarray(offset+30,offset+30+nameLength).toString('utf8'),name);
    localEnd=offset+30+nameLength+compressed;
    const data=zlib.inflateRawSync(bytes.subarray(offset+30+nameLength,localEnd));assert.equal(data.length,size);assert.equal(crc(data),checksum);
    files.set(name,data);cursor+=46+nameLength+extraLength+commentLength;
  }
  assert.equal(cursor,centralEnd);assert.equal(localEnd,bytes.readUInt32LE(end+16));return files;
}
test('release ZIP has exactly the reviewed files, valid UTF-8/CRC headers and byte-identical payloads',t=>{
  const root=fixture(t),result=buildRelease(root),bytes=fs.readFileSync(result.zipPath),files=readZip(bytes);
  assert.deepEqual([...files.keys()],EXPECTED);assert.deepEqual(result.files,EXPECTED);
  for(const [name,data]of files)assert.ok(data.equals(fs.readFileSync(path.join(root,name))),name);
  assert.equal(result.version,'0.3.1');assert.equal(path.basename(result.zipPath),'RWTH-Termin-Assistant-v0.3.1.zip');assert.equal(path.dirname(result.zipPath),path.join(root,'release'));
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');assert.equal(result.sha256,digest);
  assert.equal(fs.readFileSync(result.sha256Path,'utf8'),digest+'  RWTH-Termin-Assistant-v0.3.1.zip\n');
});
test('private files, observations, screenshots and old unpacked versions cannot enter the release',t=>{
  const root=fixture(t);
  for(const name of ['private/.env','observations/notes.txt','screenshots/private.jpg','RWTH-Termin-Assistant-v0.1.0/private.json','.env']){
    const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'SYNTHETIC_PRIVATE_DO_NOT_PUBLISH');
  }
  const files=readZip(fs.readFileSync(buildRelease(root).zipPath));assert.deepEqual([...files.keys()],EXPECTED);
  assert.equal([...files.values()].some(bytes=>bytes.includes('SYNTHETIC_PRIVATE_DO_NOT_PUBLISH')),false);
});
test('repeated builds are deterministic despite source mtimes and output location changes',t=>{
  const root=fixture(t),first=buildRelease(root),bytes=fs.readFileSync(first.zipPath);
  for(const name of EXPECTED)fs.utimesSync(path.join(root,name),new Date('2026-01-01'),new Date('2026-11-02'));
  const second=buildRelease(root,path.join(root,'other-release'));assert.ok(bytes.equals(fs.readFileSync(second.zipPath)));assert.equal(first.sha256,second.sha256);
  assert.ok(bytes.equals(fs.readFileSync(buildRelease(root).zipPath)));
});
test('version mismatches and unsafe manifest versions fail before producing an output',t=>{
  const root=fixture(t);fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.3.2'}));
  assert.throws(()=>buildRelease(root),/versions do not match/);assert.equal(fs.existsSync(path.join(root,'release')),false);
  fs.writeFileSync(path.join(root,'extension','manifest.json'),JSON.stringify({version:'../outside'}));
  assert.throws(()=>buildRelease(root),/Invalid manifest release version/);assert.equal(fs.existsSync(path.join(root,'release')),false);
});
test('unexpected runtime files and missing runtime files are rejected instead of silently packaged',t=>{
  const root=fixture(t),extra=path.join(root,'extension','private.json');fs.writeFileSync(extra,'SYNTHETIC_PRIVATE');
  assert.throws(()=>buildRelease(root),/Unexpected or missing files/);fs.unlinkSync(extra);fs.unlinkSync(path.join(root,'extension','core.js'));
  assert.throws(()=>buildRelease(root),/Unexpected or missing files/);assert.equal(fs.existsSync(path.join(root,'release')),false);
});
test('a required source replaced with a directory is rejected',t=>{
  const root=fixture(t),file=path.join(root,'README.zh-CN.txt');fs.unlinkSync(file);fs.mkdirSync(file);
  assert.throws(()=>buildRelease(root),/regular file/);assert.equal(fs.existsSync(path.join(root,'release')),false);
});
test('a symlinked runtime directory is rejected without following it',t=>{
  const root=fixture(t),original=path.join(root,'extension'),target=path.join(root,'runtime-target');
  assert.equal(path.dirname(target),root);assert.equal(path.dirname(original),root);fs.renameSync(original,target);
  try{fs.symlinkSync(target,original,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('This platform does not permit creating symlinks.');return;}throw error;}
  assert.throws(()=>buildRelease(root),/symlink/);assert.equal(fs.existsSync(path.join(root,'release')),false);
});
test('a symlinked output directory is rejected without writing into its target',t=>{
  const root=fixture(t),target=path.join(root,'output-target'),output=path.join(root,'release');fs.mkdirSync(target);
  try{fs.symlinkSync(target,output,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('This platform does not permit creating symlinks.');return;}throw error;}
  assert.throws(()=>buildRelease(root),/symlink/);assert.deepEqual(fs.readdirSync(target),[]);
});
test('a symlinked allowlist file is rejected without reading its target',t=>{
  const root=fixture(t),target=path.join(root,'private-source.txt'),file=path.join(root,'extension','core.js');fs.writeFileSync(target,'SYNTHETIC_PRIVATE');fs.unlinkSync(file);
  try{fs.symlinkSync(target,file,'file');}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('This platform does not permit file symlinks.');return;}throw error;}
  assert.throws(()=>buildRelease(root),/symlink/);assert.equal(fs.existsSync(path.join(root,'release')),false);
});
test('release outputs cannot escape the provided source root',t=>{
  const root=fixture(t);assert.throws(()=>buildRelease(root,path.resolve(root,'..','outside-release')),/within the release source root/);
});
