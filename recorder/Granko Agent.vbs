' Starts the Granko agent hidden (no console window); output goes to agent.log next to this file.
' install-autostart.ps1 puts a shortcut to this in the Windows Startup folder.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c node """ & dir & "\granko-recorder.js"" --agent >> """ & dir & "\agent.log"" 2>&1", 0, False
