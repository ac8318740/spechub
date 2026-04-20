// launcher-src.cs – tiny WindowsApplication shim that spawns a child process
// with CREATE_NO_WINDOW so no console is ever allocated.
//
// Compiled by build-launcher.ps1 to launcher.exe via PowerShell's Add-Type
// with -OutputType WindowsApplication. Compiling as a WindowsApplication is
// the load-bearing bit – a ConsoleApplication launcher would itself allocate
// a console window on spawn, defeating the purpose.
//
// Why this exists: on Windows 11 22H2+ the default terminal host is Windows
// Terminal. When PowerShell calls GetConsoleWindow() under WT, it gets a
// ConPTY proxy handle, not the actual WT window – so ShowWindow() calls on
// that handle do nothing visible. Running PowerShell under this launcher
// bypasses the problem entirely: CREATE_NO_WINDOW means no console is
// attached at all, so there is no window to hide.
//
// Usage: launcher.exe <child-exe-path> [args...]

using System;
using System.Diagnostics;
using System.Text;

class Launcher {
    static int Main(string[] args) {
        if (args.Length == 0) return 1;

        var psi = new ProcessStartInfo();
        psi.FileName = args[0];
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        // Re-join remaining args as a single Arguments string. Caller is
        // expected to pre-quote any paths with spaces.
        var sb = new StringBuilder();
        for (int i = 1; i < args.Length; i++) {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(args[i]);
        }
        psi.Arguments = sb.ToString();

        try {
            Process.Start(psi);
            return 0;
        } catch {
            return 2;
        }
    }
}
