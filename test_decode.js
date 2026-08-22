var s = require('fs').readFileSync('index.html','utf8');
var m = s.match(/var __ENCODED_COLLECTIONS__ = "([^"]+)"/);
if (!m) { console.log('NO MATCH'); process.exit(1); }
var decoded = decodeURIComponent(Buffer.from(m[1], 'base64').toString('utf8'));
console.log(decoded.substring(0, 200));
console.log('LENGTH:', decoded.length);
try { eval(decoded); console.log('COLLECTIONS defined:', typeof COLLECTIONS, 'count:', COLLECTIONS.length); } catch(e) { console.log('EVAL ERROR:', e.message); }
