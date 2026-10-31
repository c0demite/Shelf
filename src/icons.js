// Extracts icons the way Explorer does (IShellItemImageFactory): works for .exe, .ico, .lnk
// and Microsoft Store apps (shell:AppsFolder\<AUMID>), in high resolution with transparency.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SIZE = 96;
const VERSION = 'v3';

const CS = String.raw`
using System; using System.Runtime.InteropServices; using System.Drawing; using System.Drawing.Imaging;
public static class IconX {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public short bmPlanes, bmBitsPixel; public IntPtr bmBits; }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IntPtr item);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint PrivateExtractIcons(string file, int idx, int cx, int cy, IntPtr[] icons, int[] ids, uint n, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
  // Largest icon stored in an .exe/.dll/.ico, scaled to px (sharper than the shell for old 32 px icons)
  public static bool SaveFile(string src, string dst, int px) {
    try {
      var arr = new IntPtr[1]; var ids = new int[1];
      uint n = PrivateExtractIcons(src, 0, px, px, arr, ids, 1, 0);
      if (n == 0 || n == 0xFFFFFFFF || arr[0] == IntPtr.Zero) return false;
      try { using (var ic = Icon.FromHandle(arr[0])) using (var b = ic.ToBitmap()) b.Save(dst, ImageFormat.Png); }
      finally { DestroyIcon(arr[0]); }
      return true;
    } catch { return false; }
  }
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int c, ref BITMAP bm);
  public static bool Save(string src, string dst, int px) {
    try {
      Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"); IntPtr p;
      if (SHCreateItemFromParsingName(src, IntPtr.Zero, ref iid, out p) != 0 || p == IntPtr.Zero) return false;
      var f = (IShellItemImageFactory)Marshal.GetTypedObjectForIUnknown(p, typeof(IShellItemImageFactory));
      Marshal.Release(p);
      IntPtr hbm;
      if (f.GetImage(new SIZE { cx = px, cy = px }, 0x1 | 0x4, out hbm) != 0) return false; // BIGGERSIZEOK | ICONONLY
      try {
        var bm = new BITMAP(); GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), ref bm);
        if (bm.bmBits == IntPtr.Zero || bm.bmBitsPixel != 32) { using (var b0 = Image.FromHbitmap(hbm)) b0.Save(dst, ImageFormat.Png); return true; }
        int h = Math.Abs(bm.bmHeight);
        using (var b = new Bitmap(bm.bmWidth, h, PixelFormat.Format32bppPArgb)) {
          var d = b.LockBits(new Rectangle(0, 0, bm.bmWidth, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
          var row = new byte[bm.bmWidthBytes];
          int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
          for (int y = 0; y < h; y++) {
            Marshal.Copy(IntPtr.Add(bm.bmBits, y * bm.bmWidthBytes), row, 0, row.Length);
            int ty = bm.bmHeight > 0 ? h - 1 - y : y; // bottom-up DIB
            Marshal.Copy(row, 0, IntPtr.Add(d.Scan0, ty * d.Stride), Math.Min(row.Length, d.Stride));
            for (int x = 0; x < bm.bmWidth; x++) {
              if (row[x * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (ty < y0) y0 = ty; if (ty > y1) y1 = ty; }
            }
          }
          b.UnlockBits(d);
          int cw = x1 - x0 + 1, ch = y1 - y0 + 1;
          // Old programs only ship 16/32 px icons, which the shell centres on a big empty canvas: crop and enlarge
          if (x1 >= 0 && Math.Max(cw, ch) < bm.bmWidth * 0.7) {
            int side = Math.Max(cw, ch);
            using (var o = new Bitmap(px, px, PixelFormat.Format32bppPArgb))
            using (var g = Graphics.FromImage(o)) {
              g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
              g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
              float s = (float)px / side;
              g.DrawImage(b, new RectangleF((px - cw * s) / 2, (px - ch * s) / 2, cw * s, ch * s), new RectangleF(x0, y0, cw, ch), GraphicsUnit.Pixel);
              o.Save(dst, ImageFormat.Png);
            }
          } else b.Save(dst, ImageFormat.Png);
        }
        return true;
      } finally { DeleteObject(hbm); }
    } catch { return false; }
  }
}`;

// Best thing to take the icon from, in order of reliability
function iconSource(it) {
  if (it.iconPath && /\.(png|jpe?g)$/i.test(it.iconPath)) return it.iconPath; // ready-made logo (Xbox games)
  if (it.aumid) return 'shell:AppsFolder\\' + it.aumid;
  if (it.exe) return it.exe;
  if (it.iconPath && !/package cache|installer|unins/i.test(it.iconPath)) return it.iconPath;
  if (it.lnk) return it.lnk;
  return null;
}

const fileFor = (dir, src) =>
  path.join(dir, crypto.createHash('sha1').update(VERSION + src.toLowerCase()).digest('hex').slice(0, 20) + '.png');

function extractMany(sources, dir) {
  return new Promise((resolve) => {
    if (!sources.length) return resolve();
    fs.mkdirSync(dir, { recursive: true });
    // Image files need no extraction – just copy them
    for (const src of sources.filter((s) => /\.(png|jpe?g)$/i.test(s))) {
      try {
        fs.copyFileSync(src, fileFor(dir, src));
      } catch {}
    }
    sources = sources.filter((s) => !/\.(png|jpe?g)$/i.test(s));
    if (!sources.length) return resolve();
    const jobs = sources.map((src) => ({ src, dst: fileFor(dir, src) }));
    const list = path.join(dir, 'jobs.json');
    fs.writeFileSync(list, JSON.stringify(jobs));
    const ps = `
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${CS}
'@
$jobs = Get-Content -LiteralPath '${list.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($j in $jobs) { $ok = $false; if ($j.src -match '[.](exe|dll|ico)$') { $ok = [IconX]::SaveFile($j.src, $j.dst, ${SIZE}) }; if (-not $ok) { $ok = [IconX]::Save($j.src, $j.dst, ${SIZE}) }; if ($env:DEBUG_ICONS) { "$ok $($j.src)" } }
`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 120000 },
      (err, out, errOut) => {
        if (process.env.DEBUG_ICONS) console.log(err, out, errOut);
        try {
          fs.unlinkSync(list);
        } catch {}
        resolve();
      }
    );
  });
}

// Returns a data: URL, or null when nothing could be extracted
function readIcon(dir, src) {
  try {
    return 'data:image/png;base64,' + fs.readFileSync(fileFor(dir, src)).toString('base64');
  } catch {
    return null;
  }
}

const hasIcon = (dir, src) => fs.existsSync(fileFor(dir, src));

module.exports = { iconSource, extractMany, readIcon, hasIcon };
