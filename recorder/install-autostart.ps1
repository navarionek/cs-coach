param([switch]$Remove)
# Adds (or with -Remove deletes) a shortcut in the Windows Startup folder that runs the Granko agent
# hidden at login, so the Granko page can see this PC and start CS2 + the recorder remotely.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Granko Agent.lnk'
if ($Remove) {
  Remove-Item $lnk -ErrorAction SilentlyContinue
  "Usunięto autostart agenta."
  exit
}
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + (Join-Path $PSScriptRoot 'Granko Agent.vbs') + '"'
$s.WorkingDirectory = $PSScriptRoot
$s.Description = 'Granko Agent (CS2 recorder)'
$s.Save()
"Autostart agenta dodany: $lnk"
