param([string]$Exec, [string]$Beep)
# -Exec <cfg>: focuses CS2 and types "exec <cfg>" into the console (key under Esc), like a person would.
# -Beep ok|err: short confirmation sound for the recorder.
if ($Beep) {
  if ($Beep -eq 'ok') { [console]::Beep(1046, 90); [console]::Beep(1568, 120) } else { [console]::Beep(330, 300) }
  exit
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GrankoKb {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint map);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Scan codes, so the game's raw input sees real key presses.
  public static void Tap(ushort vk) {
    ushort sc = (ushort)MapVirtualKey(vk, 0);
    var down = new INPUT { type = 1, ki = new KEYBDINPUT { wScan = sc, dwFlags = 0x0008 } };
    var up = new INPUT { type = 1, ki = new KEYBDINPUT { wScan = sc, dwFlags = 0x0008 | 0x0002 } };
    SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(40);
    SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(40);
  }
}
"@
$h = (Get-Process cs2 -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
# An Alt tap lets a background process take the foreground.
[GrankoKb]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [GrankoKb]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[GrankoKb]::ShowWindow($h, 9) | Out-Null
[GrankoKb]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600
$console = 0xC0
[GrankoKb]::Tap($console); Start-Sleep -Milliseconds 500
# Letters and spaces only (cfg names are kept to [a-z]), so no shift handling is needed.
foreach ($ch in "exec $Exec".ToCharArray()) {
  if ($ch -eq ' ') { [GrankoKb]::Tap(0x20) } else { [GrankoKb]::Tap([uint16][char]::ToUpper($ch)) }
}
[GrankoKb]::Tap(0x0D); Start-Sleep -Milliseconds 400
[GrankoKb]::Tap($console)
