import fs from 'node:fs'
const { pyAdapter } = await import('./src/adapters/py.ts')
const B = process.env.TEMP + '/codyssey-bench/fastapi-fullstack/backend/app/api/routes'
for (const f of ['users.py', 'login.py', 'private.py']) {
  const src = fs.readFileSync(`${B}/${f}`, 'utf8')
  const r = await pyAdapter.parse(src, f)
  console.log(`# ${f}`)
  console.log('  routerDefs:', r.routerDefs.map(d => `${d.name} prefix='${d.prefix}'`).join(' | ') || '-')
  console.log('  routes    :', r.routes.length ? r.routes.map(x => `${x.method} ${x.path}`).join(', ') : '없음 ❌')
}
