param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# Read-only diagnostics. ACL entries are not a calculation of effective permissions.
$item = Get-Item -LiteralPath $Path
$acl = Get-Acl -LiteralPath $item.FullName
[pscustomobject]@{
  path = $item.FullName
  owner = $acl.Owner
  inheritance_disabled = $acl.AreAccessRulesProtected
  rules = @($acl.Access | ForEach-Object {
    [pscustomobject]@{
      identity = $_.IdentityReference.Value
      type = $_.AccessControlType.ToString()
      rights = $_.FileSystemRights.ToString()
      inherited = $_.IsInherited
    }
  })
} | ConvertTo-Json -Depth 5
