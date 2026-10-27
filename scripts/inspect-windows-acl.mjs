import { inspectWindowsAcl } from '../lib/windows-acl.js'

if (process.platform !== 'win32' || process.argv.length !== 3) {
  console.error('Usage on Windows: node scripts/inspect-windows-acl.mjs <path>')
  process.exitCode = 1
} else {
  try { console.log(JSON.stringify(await inspectWindowsAcl(process.argv[2]), null, 2)) }
  catch (error) { console.error(`${error.code}: ${error.message}`); process.exitCode = 1 }
}
