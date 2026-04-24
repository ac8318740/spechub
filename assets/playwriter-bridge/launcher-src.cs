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
// The launcher also acts as the real parent of the child process. It waits
// for the child to exit and propagates its exit code, and on termination
// (Stop-ScheduledTask, Ctrl+C, logoff) it walks the process tree via WMI
// and kills every descendant before exiting. Without this, Stop-ScheduledTask
// orphans the PowerShell child and the bridge keeps running.
//
// Usage: launcher.exe <child-exe-path> [args...]

using System;
using System.Diagnostics;
using System.Management;
using System.Text;

class Launcher {
    static Process child;

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

        AppDomain.CurrentDomain.ProcessExit += (s, e) => KillChildTree();
        Console.CancelKeyPress += (s, e) => { KillChildTree(); Environment.Exit(130); };

        try {
            child = Process.Start(psi);
        } catch {
            return 2;
        }
        // Process.Start can return null when no new process was actually
        // started (rare with UseShellExecute=false, but documented). Without
        // this guard, WaitForExit below would NRE.
        if (child == null) return 2;

        try {
            child.WaitForExit();
            return child.ExitCode;
        } catch {
            KillChildTree();
            return 3;
        }
    }

    // Walk Win32_Process.ParentProcessId to find every descendant of the
    // child, then kill them leaves-first. We use WMI because our Add-Type
    // compile targets .NET Framework 4.x, which lacks
    // Process.Kill(entireProcessTree: true).
    //
    // PID reuse guard: Windows recycles PIDs aggressively. Between a WMI
    // child-list query and Process.Kill(), a child can exit and its PID
    // be reassigned to an unrelated process. We capture CreationDate per
    // WMI row and verify it still matches before killing, so a recycled
    // PID pointing at an unrelated process is skipped.
    static void KillChildTree() {
        if (child == null) return;
        try {
            if (child.HasExited) return;
        } catch { return; }

        // Descendants first (leaves-first), each PID-reuse guarded via WMI
        // CreationDate. The top-level child is safe to kill directly: we
        // hold the Process handle from Process.Start, so its PID cannot
        // have been reassigned while we held it open.
        KillDescendants(child.Id);
        try { child.Kill(); } catch { }
    }

    static void KillDescendants(int pid) {
        try {
            var query = "SELECT ProcessId, CreationDate FROM Win32_Process WHERE ParentProcessId = " + pid;
            using (var searcher = new ManagementObjectSearcher(query))
            using (var results = searcher.Get()) {
                foreach (ManagementObject mo in results) {
                    int childPid = Convert.ToInt32(mo["ProcessId"]);
                    string childCreated = mo["CreationDate"] as string;
                    KillDescendants(childPid);
                    KillIfSame(childPid, childCreated);
                }
            }
        } catch { }
    }

    // Kill pid only if its current CreationDate still matches the one we
    // captured from the WMI walk – otherwise the PID has been recycled.
    static void KillIfSame(int pid, string expectedCreated) {
        if (expectedCreated == null) return;
        try {
            var query = "SELECT CreationDate FROM Win32_Process WHERE ProcessId = " + pid;
            using (var searcher = new ManagementObjectSearcher(query))
            using (var results = searcher.Get()) {
                foreach (ManagementObject mo in results) {
                    string now = mo["CreationDate"] as string;
                    if (now != expectedCreated) return;
                    try {
                        var p = Process.GetProcessById(pid);
                        p.Kill();
                    } catch { }
                    return;
                }
            }
        } catch { }
    }
}
