'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3'),{snapshot,materialize}=require('./snapshot');
test('SQLite WAL checkpoint restores committed rows into a fresh directory',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-snapshot-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'one');await fs.mkdir(dir);const db=new Database(path.join(dir,'gplus-messages.sqlite3'));db.pragma('journal_mode = WAL');db.exec('CREATE TABLE messages(value TEXT); INSERT INTO messages VALUES (\'synthetic\')');
 const files=await snapshot(dir);assert.ok(files['gplus-messages.sqlite3'].length>0);const other=path.join(root,'two');await materialize(other,files);
 const restored=new Database(path.join(other,'gplus-messages.sqlite3'));assert.equal(restored.prepare('SELECT value FROM messages').get().value,'synthetic');restored.close();db.close();
});
test('snapshot materialization does not overwrite or follow links',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-snapshot-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'accounts-v1.json'),'keep');await assert.rejects(materialize(root,{'accounts-v1.json':Buffer.from('overwrite')}));
 assert.equal((await fs.readFile(path.join(root,'accounts-v1.json'))).toString(),'keep');await fs.unlink(path.join(root,'accounts-v1.json'));
 await fs.symlink('/dev/null',path.join(root,'accounts-v1.json'));await assert.rejects(snapshot(root),/unsafe_snapshot_file/);
});
