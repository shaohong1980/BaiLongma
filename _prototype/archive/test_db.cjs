const b = require('better-sqlite3');
const db = new b('D:\\BaiLongma\\data\\memory.db');
console.log('db open ok');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('tables:', tables.map(t => t.name).join(', '));
db.close();
