param([string]$Out, [int]$Quality = 85)
# Captures the CS2 window's client area (windowed / borderless) to a JPEG.
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GrankoWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[GrankoWin]::SetProcessDPIAware() | Out-Null
$h = (Get-Process cs2 -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
$c = New-Object GrankoWin+RECT
[GrankoWin]::GetClientRect($h, [ref]$c) | Out-Null
$p = New-Object GrankoWin+POINT
[GrankoWin]::ClientToScreen($h, [ref]$p) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($c.R - $c.L), ($c.B - $c.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($p.X, $p.Y, 0, 0, $bmp.Size)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
$bmp.Save($Out, $codec, $params)
$g.Dispose(); $bmp.Dispose()
