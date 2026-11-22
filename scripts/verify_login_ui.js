const http = require('http');

function check(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const str = buf.toString('utf-8');
        resolve({
          url,
          status: res.statusCode,
          contentType: res.headers['content-type'],
          bytes: buf.length,
          hasFavicon: str.includes('rel="icon"'),
          hasNuelltech: str.includes('NUELLTECH'),
          hasTabAdmin: str.includes('tabGateAdmin'),
          hasAdminRoute: str.includes('isAdminRoute'),
        });
      });
    }).on('error', reject);
  });
}

async function run() {
  const f = await check('http://localhost:3000/favicon.ico');
  const bg = await check('http://localhost:3000/assets/login-bg.png');
  const home = await check('http://localhost:3000/');
  const admin = await check('http://localhost:3000/admin');
  console.log('--- VERIFICATION RESULTS ---');
  console.log('1. Favicon (/favicon.ico):', f.status, f.contentType, f.bytes, 'bytes');
  console.log('2. Background (/assets/login-bg.png):', bg.status, bg.contentType, bg.bytes, 'bytes');
  console.log('3. Home (/):', home.status, 'hasFavicon:', home.hasFavicon, 'hasNuelltech:', home.hasNuelltech, 'hasTabAdmin:', home.hasTabAdmin);
  console.log('4. Admin (/admin):', admin.status, 'hasAdminRoute:', admin.hasAdminRoute);
  process.exit(0);
}
run().catch(err => { console.error(err); process.exit(1); });
