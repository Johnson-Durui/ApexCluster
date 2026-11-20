import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir } from './helpers.js';

const sdk = process.env.DMW_WEBVIEW2_SDK;

test('the compiled desktop host restricts navigation to its exact local origin', {
  skip: process.platform !== 'win32' || !sdk ? 'Requires Windows and DMW_WEBVIEW2_SDK (Microsoft.Web.WebView2 1.0.4314.35)' : false,
}, () => {
  const directory = tempDir('desktop-window-policy-');
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const executable = path.join(directory, 'policy-probe.exe');
  const probe = path.join(directory, 'PolicyProbe.cs');
  const core = path.join(sdk!, 'lib/net462/Microsoft.Web.WebView2.Core.dll');
  const forms = path.join(sdk!, 'lib/net462/Microsoft.Web.WebView2.WinForms.dll');
  for (const file of [compiler, core, forms]) assert.ok(existsSync(file), `Missing build input: ${file}`);
  writeFileSync(probe, `using System;
internal static class NativePolicyProbe {
  [STAThread] private static int Main() {
    const string origin = "http://127.0.0.1:5210/";
    string[] allowed = { origin, "http://127.0.0.1:5210/api/chats", "http://127.0.0.1:5210/chat?id=1#section" };
    string[] denied = { "https://127.0.0.1:5210/", "http://127.0.0.1:5211/", "http://localhost:5210/", "http://user@127.0.0.1:5210/", "https://example.com/", "file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,hello", "about:blank", "not a URL" };
    foreach (string target in allowed) if (!DesktopAppWindow.IsAllowedNavigation(origin, target)) throw new Exception("Local navigation rejected: " + target);
    foreach (string target in denied) if (DesktopAppWindow.IsAllowedNavigation(origin, target)) throw new Exception("External navigation accepted: " + target);
    if (DesktopAppWindow.IsAllowedNavigation("https://example.com/", "https://example.com/path")) throw new Exception("Remote origin accepted");
    if (DesktopAppWindow.IsAllowedNavigation(origin, "about:srcdoc")) throw new Exception("Inline document accepted as top-level navigation");
    if (!DesktopAppWindow.IsAllowedFrameNavigation(origin, "about:srcdoc")) throw new Exception("Bundled inline product frame rejected");
    foreach (string target in allowed) if (!DesktopAppWindow.IsAllowedFrameNavigation(origin, target)) throw new Exception("Same-origin frame rejected: " + target);
    foreach (string target in denied) if (DesktopAppWindow.IsAllowedFrameNavigation(origin, target)) throw new Exception("Unsafe frame accepted: " + target);
    string[] inlineVariants = { "about:srcdoc#fragment", "about:srcdoc?query=1", "about:srcdoc/", " about:srcdoc", "about:srcdoc ", "ABOUT:SRCDOC", "data:text/html,<p>untrusted</p>", "blob:http://127.0.0.1:5210/id" };
    foreach (string target in inlineVariants) if (DesktopAppWindow.IsAllowedFrameNavigation(origin, target)) throw new Exception("Unexpected inline frame form accepted: " + target);
    string[] invalidOrigins = { "https://example.com/", "file:///C:/Windows/", "http://user@127.0.0.1:5210/", "not an origin" };
    foreach (string candidate in invalidOrigins) if (DesktopAppWindow.IsAllowedFrameNavigation(candidate, "about:srcdoc")) throw new Exception("Untrusted inline frame origin accepted: " + candidate);
    Console.WriteLine("Exact local origin policy passed: " + (allowed.Length + denied.Length + 1));
    Console.WriteLine("Trusted inline product frame policy passed");
    return 0;
  }
}
`);
  const compiled = spawnSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/define:DMW_WEBVIEW2', '/target:exe', '/main:NativePolicyProbe',
    `/out:${executable}`, '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll', `/r:${core}`, `/r:${forms}`,
    path.resolve('scripts/desktop/DesktopLauncher.cs'), path.resolve('scripts/desktop/DesktopAppWindow.cs'), probe], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  copyFileSync(core, path.join(directory, path.basename(core)));
  copyFileSync(forms, path.join(directory, path.basename(forms)));
  const checked = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /Exact local origin policy passed: 14/);
  assert.match(checked.stdout, /Trusted inline product frame policy passed/);
});

test('native packaging rejects an SDK DLL changed after extraction from the pinned package', {
  skip: process.platform !== 'win32' || !sdk ? 'Requires Windows and DMW_WEBVIEW2_SDK' : false,
}, () => {
  const directory = tempDir('desktop-sdk-tamper-');
  const fakeSdk = path.join(directory, 'sdk');
  mkdirSync(path.join(fakeSdk, 'lib/net462'), { recursive: true });
  copyFileSync(path.join(sdk!, 'Microsoft.Web.WebView2.nuspec'), path.join(fakeSdk, 'Microsoft.Web.WebView2.nuspec'));
  copyFileSync(path.join(path.dirname(sdk!), 'microsoft.web.webview2.1.0.4314.35.nupkg'), path.join(directory, 'microsoft.web.webview2.1.0.4314.35.nupkg'));
  writeFileSync(path.join(fakeSdk, 'lib/net462/Microsoft.Web.WebView2.Core.dll'), 'tampered DLL');
  const output = path.join(directory, 'must-not-be-built');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/package-portable.ps1'),
    '-OutputDirectory', output, '-NodePath', process.execPath, '-NativeDesktop', '-WebView2SdkDirectory', fakeSdk],
  { encoding: 'utf8', windowsHide: true, timeout: 30_000,
    // Windows PowerShell must load its own built-ins when this test is launched from PowerShell 7.
    env: { ...process.env, PSModulePath: path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules') } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /WebView2 SDK extracted file differs from pinned package/);
  assert.equal(existsSync(output), false, 'a tampered SDK must fail before producing a package');
});
