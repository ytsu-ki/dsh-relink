import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const command = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$item = if ([System.IO.Directory]::Exists($env:DSH_ACL_TARGET)) {
  [System.IO.DirectoryInfo]::new($env:DSH_ACL_TARGET)
} else {
  [System.IO.FileInfo]::new($env:DSH_ACL_TARGET)
}
$acl = $item.GetAccessControl()
[pscustomobject]@{
  path = $item.FullName
  owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  inheritance_disabled = $acl.AreAccessRulesProtected
  rules = @(foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    [pscustomobject]@{
      identity = $rule.IdentityReference.Value
      type = $rule.AccessControlType.ToString()
      rights = $rule.FileSystemRights.ToString()
      inherited = $rule.IsInherited
    }
  })
} | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 5
`

// The fixed query only reads a descriptor; it does not infer effective access.
export async function inspectWindowsAcl(path, { executeFile = execute } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('An ACL target path is required')
  const env = { ...process.env, DSH_ACL_TARGET: path }
  // A pwsh -> Node -> Windows PowerShell chain otherwise inherits incompatible modules.
  for (const key of Object.keys(env)) if (/^(?:PSModulePath|WinPSModulePath|PSModuleAnalysisCachePath)$/i.test(key)) delete env[key]
  let stdout
  try {
    const request = executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      // Windows PowerShell/.NET can initialize before any query line executes.
      env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    })
    request.child?.stdin?.end()
    ;({ stdout } = await request)
  } catch (cause) {
    const reason = cause.killed ? 'TIMEOUT' : /^[A-Z_]+$/.test(String(cause.code)) ? cause.code : 'PROCESS_FAILED'
    throw Object.assign(new Error(`Windows ACL diagnostic unavailable (${reason})`), { code: 'ACL_DIAGNOSTIC_UNAVAILABLE' })
  }
  try {
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (!result || typeof result.path !== 'string' || typeof result.owner !== 'string'
      || typeof result.inheritance_disabled !== 'boolean' || !Array.isArray(result.rules)
      || result.rules.some(rule => !rule || typeof rule.identity !== 'string' || typeof rule.type !== 'string'
        || typeof rule.rights !== 'string' || typeof rule.inherited !== 'boolean')) throw new Error('Invalid ACL shape')
    return result
  } catch { throw Object.assign(new Error('Windows ACL diagnostic returned invalid JSON data'), { code: 'ACL_INVALID_RESPONSE' }) }
}
