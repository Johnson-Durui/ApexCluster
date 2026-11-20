using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class DesktopLauncher
{
    private const string ProtocolPrefix = "DMW_DESKTOP ";

    [STAThread]
    private static int Main(string[] args)
    {
        bool selfTest = args.Length == 1 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase);
        bool smokeTest = args.Length == 1 && String.Equals(args[0], "--smoke-test", StringComparison.OrdinalIgnoreCase);
        bool browserWindow = args.Length == 1 && String.Equals(args[0], "--browser-window", StringComparison.OrdinalIgnoreCase);
        bool normal = args.Length == 0 || browserWindow;

        if (!selfTest && !smokeTest && !normal)
        {
            return 64;
        }

        LauncherPaths paths = LauncherPaths.FromExecutable();
        LauncherLog log = new LauncherLog(paths.LogPath);

#if DMW_WEBVIEW2
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
#endif

        try
        {
            if (selfTest)
            {
                return RunSelfTest(paths, log);
            }

            string packageId = ComputePackageId(paths.PackageRoot);
            string mutexName = "Local\\DMWDesktop_" + packageId;
            string pipeName = "DMWDesktop_" + packageId;
            bool createdNew;

            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    if (smokeTest)
                    {
                        WriteResult(paths.SmokeResultPath, false, "已有相同软件包实例正在运行。", null);
                        return 65;
                    }

                    SignalExistingInstance(pipeName, log);
                    return 0;
                }

                using (LauncherController controller = new LauncherController(paths, pipeName, log, browserWindow))
                {
                    return smokeTest ? controller.RunSmokeTest() : controller.RunInteractive();
                }
            }
        }
        catch (Exception exception)
        {
            log.Error("Launcher failure", exception);
            if (smokeTest)
            {
                WriteResult(paths.SmokeResultPath, false, exception.Message, null);
            }
            else if (!selfTest)
            {
                MessageBox.Show(
                    "双模型工作台启动失败。\r\n\r\n" + exception.Message + "\r\n\r\n日志：" + paths.LogPath,
                    "双模型工作台",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            return 99;
        }
    }

    private static int RunSelfTest(LauncherPaths paths, LauncherLog log)
    {
        Dictionary<string, object> details = new Dictionary<string, object>();
        try
        {
            string packageId = ComputePackageId(paths.PackageRoot);
            string quoted = LauncherController.QuoteArgument("C:\\路径 with space\\desktop.mjs");
            ProtocolMessage ready = ProtocolMessage.Parse(ProtocolPrefix + "{\"type\":\"ready\",\"url\":\"http://127.0.0.1:4567/\",\"pid\":123}");
            bool passed = packageId.Length == 32
                && quoted == "\"C:\\路径 with space\\desktop.mjs\""
                && ready != null
                && ready.Type == "ready"
                && LauncherController.IsAllowedLocalUrl(ready.Url)
                && !LauncherController.IsAllowedLocalUrl("https://example.com/");

            details["packageId"] = packageId;
            details["protocolType"] = ready == null ? null : ready.Type;
            details["localUrlAccepted"] = ready != null && LauncherController.IsAllowedLocalUrl(ready.Url);
            details["remoteUrlRejected"] = !LauncherController.IsAllowedLocalUrl("https://example.com/");
#if DMW_WEBVIEW2
            string webViewVersion = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
            details["desktopHost"] = "winforms-webview2";
            details["webView2Runtime"] = webViewVersion;
            passed = passed && !String.IsNullOrEmpty(webViewVersion);
#endif
            WriteResult(paths.SelfTestResultPath, passed, passed ? "ok" : "self-test assertion failed", details);
            log.Info("Self-test " + (passed ? "passed" : "failed"));
            return passed ? 0 : 70;
        }
        catch (Exception exception)
        {
            log.Error("Self-test failure", exception);
            WriteResult(paths.SelfTestResultPath, false, exception.Message, details);
            return 70;
        }
    }

    private static string ComputePackageId(string packageRoot)
    {
        string normalized = Path.GetFullPath(packageRoot).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant();
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(normalized));
            StringBuilder result = new StringBuilder(32);
            for (int index = 0; index < 16; index++)
            {
                result.Append(digest[index].ToString("X2", CultureInfo.InvariantCulture));
            }
            return result.ToString();
        }
    }

    private static void SignalExistingInstance(string pipeName, LauncherLog log)
    {
        for (int attempt = 0; attempt < 12; attempt++)
        {
            try
            {
                using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
                {
                    client.Connect(400);
                    using (StreamWriter writer = new StreamWriter(client, new UTF8Encoding(false)))
                    {
                        writer.AutoFlush = true;
                        writer.WriteLine("activate");
                    }
                }
                log.Info("Activation signal sent to the existing instance.");
                return;
            }
            catch (TimeoutException)
            {
                Thread.Sleep(100);
            }
            catch (IOException)
            {
                Thread.Sleep(100);
            }
        }

        log.Info("Existing instance was detected, but its activation pipe was not ready.");
    }

    internal static void WriteResult(string path, bool success, string message, IDictionary<string, object> details)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        Dictionary<string, object> result = new Dictionary<string, object>();
        result["success"] = success;
        result["message"] = message;
        result["timestampUtc"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        if (details != null)
        {
            result["details"] = details;
        }
        string json = new JavaScriptSerializer().Serialize(result);
        File.WriteAllText(path, json, new UTF8Encoding(false));
    }
}

internal sealed class LauncherController : IDisposable
{
    private readonly LauncherPaths paths;
    private readonly string pipeName;
    private readonly LauncherLog log;
    private readonly bool browserWindow;
    private readonly object messageLock = new object();
    private readonly List<ProtocolMessage> messages = new List<ProtocolMessage>();
    private readonly AutoResetEvent messageSignal = new AutoResetEvent(false);
    private Process nodeProcess;
    private StreamWriter nodeInput;
    private volatile bool disposing;
    private string readyUrl;
    private int cachedEdgeProcessId;
    private DateTime cachedEdgeProcessStartUtc;
    private DateTime nextEdgeDiscoveryUtc = DateTime.MinValue;
#if DMW_WEBVIEW2
    private DesktopAppWindow desktopWindow;
    private bool desktopStopPending;
    private Exception desktopFailure;
    private IntPtr desktopOwner;
#endif

    public LauncherController(LauncherPaths paths, string pipeName, LauncherLog log, bool browserWindow = false)
    {
        this.paths = paths;
        this.pipeName = pipeName;
        this.log = log;
        this.browserWindow = browserWindow;
    }

    public int RunSmokeTest()
    {
        Dictionary<string, object> details = new Dictionary<string, object>();
        try
        {
            ValidateLayout(false);
            StartNode();
            ProtocolMessage ready = WaitForProtocol(60000, "ready", "error");
            EnsureReady(ready);
            details["url"] = ready.Url;
            details["pid"] = ready.Pid;

            SendStop(false);
            ProtocolMessage stopped = WaitForProtocol(30000, "stopped", "busy", "error");
            if (stopped == null)
            {
                throw new LauncherFailure("Node 没有回应停止请求。");
            }
            if (stopped.Type == "busy")
            {
                throw new LauncherFailure("冒烟测试期间 Node 报告仍有任务，已拒绝强制停止。");
            }
            if (stopped.Type == "error")
            {
                throw new LauncherFailure(GetProtocolError(stopped));
            }

            WaitForNodeExit(30000);
            DesktopLauncher.WriteResult(paths.SmokeResultPath, true, "ok", details);
            return 0;
        }
        catch (Exception exception)
        {
            log.Error("Smoke test failure", exception);
            DesktopLauncher.WriteResult(paths.SmokeResultPath, false, exception.Message, details);
            return 71;
        }
        finally
        {
            CloseNodeInput();
        }
    }

    public int RunInteractive()
    {
#if DMW_WEBVIEW2
        return RunDesktopApplication();
#else
        ValidateLayout(true);
        StartActivationPipe();
        StartNode();

        ProtocolMessage ready = WaitForProtocol(60000, "ready", "error");
        EnsureReady(ready);
        readyUrl = ready.Url;
        log.Info("Node ready at " + readyUrl + ".");

        while (true)
        {
            LaunchEdge();
            WaitForEdgeWindowToClose();
            SendStop(false);

            ProtocolMessage response = WaitForProtocol(30000, "stopped", "busy", "error");
            if (response == null)
            {
                throw new LauncherFailure("关闭窗口后，Node 没有回应停止请求。请查看日志。");
            }
            if (response.Type == "error")
            {
                if (ReportRecoverableProtocolError(response))
                {
                    continue;
                }
                throw new LauncherFailure(GetProtocolError(response));
            }
            if (response.Type == "stopped")
            {
                WaitForNodeExit(30000);
                return 0;
            }

            DialogResult answer = MessageBox.Show(
                BuildBusyMessage(response),
                "双模型工作台仍在运行任务",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);

            if (answer == DialogResult.Cancel)
            {
                log.Info("User cancelled shutdown; reopening the application window.");
                continue;
            }

            SendStop(true);
            ProtocolMessage forced = WaitForProtocol(60000, "stopped", "error");
            if (forced == null)
            {
                throw new LauncherFailure("Node 没有完成强制停止请求。未知进程未被终止，请查看日志。");
            }
            if (forced.Type == "error")
            {
                if (ReportRecoverableProtocolError(forced))
                {
                    continue;
                }
                throw new LauncherFailure(GetProtocolError(forced));
            }

            WaitForNodeExit(30000);
            return 0;
        }
#endif
    }

#if DMW_WEBVIEW2
    private int RunDesktopApplication()
    {
        ValidateLayout(false);
        StartActivationPipe();
        StartNode();
        ProtocolMessage ready = WaitForProtocol(60000, "ready", "error");
        EnsureReady(ready);
        readyUrl = ready.Url;
        log.Info("Node ready at " + readyUrl + ".");

        using (desktopWindow = new DesktopAppWindow(readyUrl,
            Path.Combine(paths.WorkPath, "webview2-profile"),
            Path.Combine(paths.PackageRoot, "downloads"), log.Info))
        using (System.Windows.Forms.Timer monitor = new System.Windows.Forms.Timer())
        {
            desktopWindow.CloseRequested += async delegate { await StopDesktopApplication(); };
            desktopWindow.FatalError += async delegate(string message)
            {
                desktopFailure = new LauncherFailure(message);
                log.Error("Embedded browser failed", desktopFailure);
                await StopDesktopApplication();
            };
            desktopWindow.Shown += async delegate
            {
                desktopOwner = desktopWindow.Handle;
                log.Info("Native application window shown.");
                bool initializationFailed = false;
                try
                {
                    await desktopWindow.InitializeAsync();
                    log.Info("Embedded interface ready at " + readyUrl + ".");
                }
                catch (Exception exception)
                {
                    if (exception is OperationCanceledException &&
                        (desktopStopPending || desktopWindow.IsDisposed)) return;
                    desktopFailure = exception;
                    log.Error("Embedded interface initialization failed", exception);
                    initializationFailed = true;
                }
                if (initializationFailed) await StopDesktopApplication();
            };
            monitor.Interval = 1000;
            monitor.Tick += delegate
            {
                if (desktopStopPending || desktopWindow.IsDisposed || nodeProcess == null || !nodeProcess.HasExited) return;
                desktopFailure = new LauncherFailure("工作台后台意外退出，请查看启动日志。");
                log.Error("Desktop backend exited unexpectedly", desktopFailure);
                desktopWindow.CloseAfterStop();
            };
            monitor.Start();
            Application.Run(desktopWindow);
            monitor.Stop();
            desktopOwner = IntPtr.Zero;
        }
        desktopWindow = null;
        if (desktopFailure != null) throw new LauncherFailure("桌面工作台未能正常运行：" + desktopFailure.Message);
        return 0;
    }

    private async Task StopDesktopApplication()
    {
        if (desktopStopPending || desktopWindow == null || desktopWindow.IsDisposed) return;
        desktopStopPending = true;
        desktopWindow.SetStatus("正在安全关闭工作台…");
        log.Info("Native application window close requested.");
        try
        {
            ProtocolMessage response = await Task.Run(delegate
            {
                SendStop(false);
                return WaitForProtocol(30000, "stopped", "busy", "error");
            });
            if (response != null && response.Type == "busy")
            {
                DialogResult answer = MessageBox.Show(desktopWindow,
                    BuildBusyMessage(response).Replace("将重新打开工作台", "将保留工作台窗口"),
                    "工作台仍在运行任务", MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer == DialogResult.Cancel)
                {
                    log.Info("User cancelled native window shutdown.");
                    desktopWindow.SetStatus("已连接 · 任务继续运行");
                    return;
                }
                response = await Task.Run(delegate
                {
                    SendStop(true);
                    return WaitForProtocol(60000, "stopped", "error");
                });
            }
            if (response == null) throw new LauncherFailure("后台未确认停止，窗口暂时保持打开。");
            if (response.Type == "error") throw new LauncherFailure(GetProtocolError(response));
            if (response.Type != "stopped") throw new LauncherFailure("后台没有安全停止，窗口暂时保持打开。");
            await Task.Run(delegate { WaitForNodeExit(30000); });
            log.Info("Native application window closing after confirmed backend exit.");
            desktopWindow.CloseAfterStop();
        }
        catch (Exception exception)
        {
            log.Error("Native window stop failed", exception);
            if (nodeProcess == null || nodeProcess.HasExited)
            {
                desktopFailure = exception;
                desktopWindow.CloseAfterStop();
            }
            else
            {
                desktopWindow.SetStatus("未能安全关闭 · 后台仍在运行");
                MessageBox.Show(desktopWindow, exception.Message + "\r\n\r\n日志：" + paths.LogPath,
                    "工作台未能安全关闭", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        finally { desktopStopPending = false; }
    }
#endif

    private void ValidateLayout(bool requireEdge)
    {
        List<string> missing = new List<string>();
        if (!File.Exists(paths.NodePath)) missing.Add(paths.NodePath);
        if (!File.Exists(paths.DesktopScriptPath)) missing.Add(paths.DesktopScriptPath);
        if (!Directory.Exists(paths.WebDistPath)) missing.Add(paths.WebDistPath);
        if (!Directory.Exists(paths.ConfigPath)) missing.Add(paths.ConfigPath);
        if (requireEdge && String.IsNullOrEmpty(paths.EdgePath)) missing.Add("Microsoft Edge");
        if (missing.Count > 0)
        {
            throw new LauncherFailure("软件包不完整，缺少：\r\n" + String.Join("\r\n", missing.ToArray()));
        }

        Directory.CreateDirectory(paths.WorkPath);
        Directory.CreateDirectory(paths.EdgeProfilePath);
        Directory.CreateDirectory(paths.LogDirectory);
    }

    private void StartNode()
    {
        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = paths.NodePath;
        startInfo.Arguments = QuoteArgument(paths.DesktopScriptPath);
        startInfo.WorkingDirectory = paths.AppPath;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardInput = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.StandardOutputEncoding = new UTF8Encoding(false);
        startInfo.StandardErrorEncoding = new UTF8Encoding(false);

        nodeProcess = new Process();
        nodeProcess.StartInfo = startInfo;
        nodeProcess.EnableRaisingEvents = true;
        nodeProcess.OutputDataReceived += OnNodeOutput;
        nodeProcess.ErrorDataReceived += OnNodeError;
        nodeProcess.Exited += OnNodeExited;

        if (!nodeProcess.Start())
        {
            throw new LauncherFailure("无法启动内置 Node 运行时。");
        }
        nodeInput = nodeProcess.StandardInput;
        nodeInput.AutoFlush = true;
        nodeInput.NewLine = "\n";
        nodeProcess.BeginOutputReadLine();
        nodeProcess.BeginErrorReadLine();
        log.Info("Node controller started, pid=" + nodeProcess.Id.ToString(CultureInfo.InvariantCulture) + ".");
    }

    private void OnNodeOutput(object sender, DataReceivedEventArgs args)
    {
        if (disposing) return;
        if (args.Data == null) return;
        if (args.Data.StartsWith("DMW_DESKTOP ", StringComparison.Ordinal))
        {
            try
            {
                ProtocolMessage message = ProtocolMessage.Parse(args.Data);
                if (message != null)
                {
                    if (message.Type == "folder_request")
                    {
                        OpenFolderPicker(message.GetString("requestId"));
                        return;
                    }
                    lock (messageLock)
                    {
                        messages.Add(message);
                    }
                    log.Info("Protocol message: " + message.Type + ".");
                    // The host already cancelled that selection; keep its reason, which the window only shows as "未选择目录".
                    if (message.Type == "folder_error") log.Info("Folder was not granted: " + OneLine(message.GetString("message")));
                    SignalMessage();
                    return;
                }
            }
            catch (Exception exception)
            {
                log.Error("Invalid protocol line", exception);
            }
        }
        log.Info("node stdout: " + args.Data);
    }

    private void OnNodeError(object sender, DataReceivedEventArgs args)
    {
        if (disposing) return;
        if (args.Data != null)
        {
            log.Info("node stderr: " + args.Data);
        }
    }

    private ProtocolMessage WaitForProtocol(int timeoutMilliseconds, params string[] acceptedTypes)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        while (DateTime.UtcNow < deadline)
        {
            lock (messageLock)
            {
                for (int index = 0; index < messages.Count; index++)
                {
                    if (acceptedTypes.Contains(messages[index].Type, StringComparer.OrdinalIgnoreCase))
                    {
                        ProtocolMessage result = messages[index];
                        messages.RemoveAt(index);
                        return result;
                    }
                }
            }

            if (nodeProcess != null && nodeProcess.HasExited)
            {
                return null;
            }
            int remaining = (int)Math.Max(1, Math.Min(500, (deadline - DateTime.UtcNow).TotalMilliseconds));
            messageSignal.WaitOne(remaining);
        }
        return null;
    }

    private void EnsureReady(ProtocolMessage message)
    {
        if (message == null)
        {
            throw new LauncherFailure("Node 未在规定时间内完成启动，或已提前退出。");
        }
        if (message.Type == "error")
        {
            throw new LauncherFailure(GetProtocolError(message));
        }
        if (!IsAllowedLocalUrl(message.Url))
        {
            throw new LauncherFailure("Node 返回了无效或非本机地址，已拒绝打开：" + (message.Url ?? "(empty)"));
        }
    }

    // .NET Framework writes a child's stdin in the console code page (GBK on Chinese Windows) while Node reads UTF-8,
    // so a Chinese folder name arrived garbled and the grant failed. Escaping everything outside printable ASCII
    // makes the bytes identical in every code page; JSON.parse restores the original string, surrogates included.
    internal static string AsciiJson(object value)
    {
        string json = new JavaScriptSerializer().Serialize(value);
        StringBuilder builder = new StringBuilder(json.Length);
        foreach (char character in json)
        {
            if (character < 0x20 || character > 0x7E) builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            else builder.Append(character);
        }
        return builder.ToString();
    }

    private void SendStop(bool force)
    {
        Dictionary<string, object> command = new Dictionary<string, object>();
        command["command"] = "stop";
        command["force"] = force;
        string json = AsciiJson(command);
        lock (nodeInput)
        {
            nodeInput.WriteLine(json);
            nodeInput.Flush();
        }
        log.Info("Stop requested, force=" + force.ToString() + ".");
    }

    private void OpenFolderPicker(string requestId)
    {
        Guid parsed;
        if (!Guid.TryParse(requestId, out parsed)) throw new InvalidDataException("Invalid folder request identity.");
        Action showDialog = delegate()
        {
            string selected = null;
            try
            {
#if DMW_WEBVIEW2
                selected = ProjectFolderPicker.Select(desktopOwner);
#else
                selected = ProjectFolderPicker.Select();
#endif
                string resolved = RealDirectoryPath.Resolve(selected);
                if (resolved != null && !String.Equals(resolved, selected, StringComparison.OrdinalIgnoreCase))
                    log.Info("Selected folder goes through a link; sending its real path: " + selected + " -> " + resolved);
                Dictionary<string, object> reply = new Dictionary<string, object>();
                reply["command"] = "folder-selected";
                reply["requestId"] = requestId;
                reply["path"] = resolved;
                string json = AsciiJson(reply);
                if (!disposing && nodeInput != null)
                {
                    lock (nodeInput)
                    {
                        nodeInput.WriteLine(json);
                        nodeInput.Flush();
                    }
                }
            }
            catch (Exception exception) { log.Error("Folder selection failed", exception); }
        };
#if DMW_WEBVIEW2
        // The owned modal belongs to the same STA/message pump as the native main window.
        // This is scheduled from the stdout reader, outside a WebView2 callback.
        if (desktopWindow != null && !desktopWindow.IsDisposed)
            desktopWindow.BeginInvoke(showDialog);
#else
        Thread dialogThread = new Thread(new ThreadStart(showDialog.Invoke));
        dialogThread.SetApartmentState(ApartmentState.STA);
        dialogThread.IsBackground = true;
        dialogThread.Start();
#endif
    }

    private void WaitForNodeExit(int timeoutMilliseconds)
    {
        if (nodeProcess == null) return;
        if (!nodeProcess.WaitForExit(timeoutMilliseconds))
        {
            throw new LauncherFailure("Node 已报告停止，但未在规定时间内退出；未强制终止未知进程。");
        }
        nodeProcess.WaitForExit();
        int exitCode = nodeProcess.ExitCode;
        log.Info("Node exited with code " + exitCode.ToString(CultureInfo.InvariantCulture) + ".");
        if (exitCode != 0)
        {
            throw new LauncherFailure("Node 停止时返回非零退出码 " + exitCode.ToString(CultureInfo.InvariantCulture) + "，本次关闭未判定为成功。");
        }
    }

    private void LaunchEdge()
    {
        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = paths.EdgePath;
        startInfo.Arguments = (browserWindow ? "--new-window " : "--app=") + QuoteArgument(readyUrl)
            + " --user-data-dir=" + QuoteArgument(paths.EdgeProfilePath)
            + " --no-first-run --disable-background-mode";
        startInfo.WorkingDirectory = paths.PackageRoot;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        Process launched = Process.Start(startInfo);
        if (launched != null)
        {
            CacheEdgeProcess(launched);
            launched.Dispose();
        }
        log.Info("Edge application window requested with the dedicated profile.");
    }

    private void WaitForEdgeWindowToClose()
    {
        DateTime appearanceDeadline = DateTime.UtcNow.AddSeconds(30);
        bool appeared = false;
        int missingPolls = 0;

        while (true)
        {
            ProtocolMessage asynchronousError = TryTakeProtocol("error");
            if (asynchronousError != null)
            {
                throw new LauncherFailure(GetProtocolError(asynchronousError));
            }
            if (nodeProcess.HasExited)
            {
                throw new LauncherFailure("工作台窗口仍在使用时，Node 服务意外退出。请查看日志。");
            }

            IntPtr window = FindEdgeWindow();
            if (window != IntPtr.Zero)
            {
                appeared = true;
                missingPolls = 0;
            }
            else if (appeared)
            {
                missingPolls++;
                if (missingPolls >= 6)
                {
                    log.Info("Dedicated Edge application window closed.");
                    return;
                }
            }
            else if (DateTime.UtcNow >= appearanceDeadline)
            {
                throw new LauncherFailure("Edge 独立窗口未能打开。Node 服务将通过标准输入关闭。");
            }

            Thread.Sleep(500);
        }
    }

    private ProtocolMessage TryTakeProtocol(string type)
    {
        lock (messageLock)
        {
            for (int index = 0; index < messages.Count; index++)
            {
                if (String.Equals(messages[index].Type, type, StringComparison.OrdinalIgnoreCase))
                {
                    ProtocolMessage result = messages[index];
                    messages.RemoveAt(index);
                    return result;
                }
            }
        }
        return null;
    }

    private IntPtr FindEdgeWindow()
    {
        IntPtr cachedWindow = FindCachedEdgeWindow();
        if (cachedWindow != IntPtr.Zero) return cachedWindow;
        if (DateTime.UtcNow < nextEdgeDiscoveryUtc) return IntPtr.Zero;
        nextEdgeDiscoveryUtc = DateTime.UtcNow.AddSeconds(2);

        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
            using (ManagementObjectCollection results = searcher.Get())
            {
                foreach (ManagementObject item in results)
                {
                    string commandLine = item["CommandLine"] as string;
                    if (!CommandLineUsesDedicatedProfile(commandLine)) continue;

                    int processId = Convert.ToInt32(item["ProcessId"], CultureInfo.InvariantCulture);
                    try
                    {
                        using (Process process = Process.GetProcessById(processId))
                        {
                            process.Refresh();
                            IntPtr handle = process.MainWindowHandle;
                            if (handle != IntPtr.Zero && IsWindowVisible(handle))
                            {
                                CacheEdgeProcess(process);
                                return handle;
                            }
                        }
                    }
                    catch (ArgumentException) { }
                    catch (InvalidOperationException) { }
                }
            }
        }
        catch (ManagementException exception)
        {
            log.Error("Edge process inspection failed", exception);
        }
        return IntPtr.Zero;
    }

    private bool CommandLineUsesDedicatedProfile(string commandLine)
    {
        if (String.IsNullOrEmpty(commandLine)) return false;
        string expectedProfile = NormalizePath(paths.EdgeProfilePath);
        string[] arguments = ParseWindowsCommandLine(commandLine);
        for (int index = 0; index < arguments.Length; index++)
        {
            string value = null;
            const string switchWithValue = "--user-data-dir=";
            if (arguments[index].StartsWith(switchWithValue, StringComparison.OrdinalIgnoreCase))
            {
                value = arguments[index].Substring(switchWithValue.Length);
            }
            else if (String.Equals(arguments[index], "--user-data-dir", StringComparison.OrdinalIgnoreCase) && index + 1 < arguments.Length)
            {
                value = arguments[++index];
            }

            if (!String.IsNullOrEmpty(value))
            {
                try
                {
                    if (String.Equals(NormalizePath(value), expectedProfile, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch (Exception exception)
                {
                    if (exception is ArgumentException || exception is NotSupportedException || exception is PathTooLongException) continue;
                    throw;
                }
            }
        }
        return false;
    }

    private IntPtr FindCachedEdgeWindow()
    {
        if (cachedEdgeProcessId == 0) return IntPtr.Zero;
        try
        {
            using (Process process = Process.GetProcessById(cachedEdgeProcessId))
            {
                process.Refresh();
                if (process.StartTime.ToUniversalTime() != cachedEdgeProcessStartUtc)
                {
                    ClearCachedEdgeProcess();
                    return IntPtr.Zero;
                }
                IntPtr handle = process.MainWindowHandle;
                return handle != IntPtr.Zero && IsWindowVisible(handle) ? handle : IntPtr.Zero;
            }
        }
        catch (ArgumentException)
        {
            ClearCachedEdgeProcess();
            return IntPtr.Zero;
        }
        catch (InvalidOperationException)
        {
            ClearCachedEdgeProcess();
            return IntPtr.Zero;
        }
    }

    private void CacheEdgeProcess(Process process)
    {
        try
        {
            process.Refresh();
            cachedEdgeProcessId = process.Id;
            cachedEdgeProcessStartUtc = process.StartTime.ToUniversalTime();
        }
        catch (InvalidOperationException)
        {
            ClearCachedEdgeProcess();
        }
    }

    private void ClearCachedEdgeProcess()
    {
        cachedEdgeProcessId = 0;
        cachedEdgeProcessStartUtc = DateTime.MinValue;
    }

    private static string NormalizePath(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static string[] ParseWindowsCommandLine(string commandLine)
    {
        int argumentCount;
        IntPtr argumentVector = CommandLineToArgvW(commandLine, out argumentCount);
        if (argumentVector == IntPtr.Zero) return new string[0];
        try
        {
            string[] result = new string[argumentCount];
            for (int index = 0; index < argumentCount; index++)
            {
                IntPtr argument = Marshal.ReadIntPtr(argumentVector, index * IntPtr.Size);
                result[index] = Marshal.PtrToStringUni(argument);
            }
            return result;
        }
        finally
        {
            LocalFree(argumentVector);
        }
    }

    private void ActivateEdgeWindow()
    {
#if DMW_WEBVIEW2
        if (desktopWindow != null) desktopWindow.ActivateApplication();
        log.Info("Existing native application window activation requested.");
#else
        IntPtr window = FindEdgeWindow();
        if (window == IntPtr.Zero) return;
        ShowWindowAsync(window, 9);
        SetForegroundWindow(window);
        log.Info("Existing Edge application window activation requested.");
#endif
    }

    private void StartActivationPipe()
    {
        Thread pipeThread = new Thread(new ThreadStart(delegate
        {
            while (!disposing)
            {
                try
                {
                    using (NamedPipeServerStream server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                    {
                        server.WaitForConnection();
                        using (StreamReader reader = new StreamReader(server, Encoding.UTF8))
                        {
                            string command = reader.ReadLine();
                            if (String.Equals(command, "activate", StringComparison.Ordinal))
                            {
                                ActivateEdgeWindow();
                            }
                        }
                    }
                }
                catch (IOException exception)
                {
                    if (!disposing) log.Error("Activation pipe failure", exception);
                }
            }
        }));
        pipeThread.IsBackground = true;
        pipeThread.Name = "DMW activation pipe";
        pipeThread.Start();
    }

    private static string OneLine(string text)
    {
        if (String.IsNullOrEmpty(text)) return "（未说明原因）";
        return text.Replace("\r", " ").Replace("\n", " ");
    }

    private static string GetProtocolError(ProtocolMessage message)
    {
        string text = message.GetString("message");
        if (String.IsNullOrEmpty(text)) text = message.GetString("error");
        return String.IsNullOrEmpty(text) ? "Node 报告错误，请查看日志。" : text;
    }

    private static string BuildBusyMessage(ProtocolMessage message)
    {
        string tasks = message.DescribeValue("tasks");
        string jobs = message.DescribeValue("jobs");
        return "工作台中仍有正在执行的任务。\r\n\r\n任务：" + tasks
            + "\r\n作业：" + jobs
            + "\r\n\r\n选择“确定”将取消任务并退出；选择“取消”将重新打开工作台。";
    }

    private bool ReportRecoverableProtocolError(ProtocolMessage message)
    {
        string error = GetProtocolError(message);
        log.Error("Stop request was rejected by Node", new LauncherFailure(error));
        bool nodeExited = nodeProcess == null || nodeProcess.HasExited;
        MessageBox.Show(
            error + "\r\n\r\n为避免误取消仍在运行的任务，工作台服务将保持运行。\r\n\r\n日志：" + paths.LogPath,
            "双模型工作台未能安全关闭",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
        return !nodeExited;
    }

    public static bool IsAllowedLocalUrl(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
        return uri.IsLoopback;
    }

    public static string QuoteArgument(string value)
    {
        if (value == null) return "\"\"";
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private void CloseNodeInput()
    {
        if (nodeInput == null) return;
        try { nodeInput.Close(); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        nodeInput = null;
    }

    public void Dispose()
    {
        disposing = true;
        CloseNodeInput();
        if (nodeProcess != null)
        {
            nodeProcess.OutputDataReceived -= OnNodeOutput;
            nodeProcess.ErrorDataReceived -= OnNodeError;
            nodeProcess.Exited -= OnNodeExited;
            try { nodeProcess.CancelOutputRead(); }
            catch (InvalidOperationException) { }
            try { nodeProcess.CancelErrorRead(); }
            catch (InvalidOperationException) { }
            nodeProcess.Dispose();
            nodeProcess = null;
        }
        messageSignal.Dispose();
    }

    private void OnNodeExited(object sender, EventArgs args)
    {
        SignalMessage();
    }

    private void SignalMessage()
    {
        if (disposing) return;
        try { messageSignal.Set(); }
        catch (ObjectDisposedException) { }
    }

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}

internal sealed class ProtocolMessage
{
    private readonly Dictionary<string, object> values;

    private ProtocolMessage(Dictionary<string, object> values)
    {
        this.values = values;
        Type = GetString("type");
        Url = GetString("url");
        Pid = GetNullableInt("pid");
    }

    public string Type { get; private set; }
    public string Url { get; private set; }
    public int? Pid { get; private set; }

    public static ProtocolMessage Parse(string line)
    {
        const string prefix = "DMW_DESKTOP ";
        if (String.IsNullOrEmpty(line) || !line.StartsWith(prefix, StringComparison.Ordinal)) return null;
        object parsed = new JavaScriptSerializer().DeserializeObject(line.Substring(prefix.Length));
        Dictionary<string, object> dictionary = parsed as Dictionary<string, object>;
        if (dictionary == null) throw new InvalidDataException("Protocol payload is not a JSON object.");
        ProtocolMessage message = new ProtocolMessage(dictionary);
        if (String.IsNullOrEmpty(message.Type)) throw new InvalidDataException("Protocol payload has no type.");
        return message;
    }

    public string GetString(string key)
    {
        object value;
        if (!values.TryGetValue(key, out value) || value == null) return null;
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    public string DescribeValue(string key)
    {
        object value;
        if (!values.TryGetValue(key, out value) || value == null) return "未知";
        object[] array = value as object[];
        if (array != null) return array.Length.ToString(CultureInfo.InvariantCulture);
        System.Collections.ArrayList list = value as System.Collections.ArrayList;
        if (list != null) return list.Count.ToString(CultureInfo.InvariantCulture);
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    private int? GetNullableInt(string key)
    {
        object value;
        if (!values.TryGetValue(key, out value) || value == null) return null;
        try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
        catch (FormatException) { return null; }
        catch (OverflowException) { return null; }
    }
}

// The Common Item Dialog supplies Explorer navigation, an address bar and search
// on .NET Framework, whose FolderBrowserDialog still uses the legacy tree UI.
internal static class ProjectFolderPicker
{
    private const uint PickFolders = 0x20;
    private const uint ForceFileSystem = 0x40;
    private const uint PathMustExist = 0x800;
    private const uint NoChangeDirectory = 0x8;
    private const uint FileSystemPath = 0x80058000;
    private const int Cancelled = unchecked((int)0x800704C7);

    internal static string Select()
    {
        return Select(IntPtr.Zero);
    }

    internal static string Select(IntPtr owner)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        IShellItem selected = null;
        IntPtr displayName = IntPtr.Zero;
        try
        {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | PickFolders | ForceFileSystem | PathMustExist | NoChangeDirectory);
            dialog.SetTitle("选择项目文件夹");
            dialog.SetOkButtonLabel("选择文件夹");
            int result = dialog.Show(owner);
            if (result == Cancelled) return null;
            Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out selected);
            selected.GetDisplayName(FileSystemPath, out displayName);
            string directory = Marshal.PtrToStringUni(displayName);
            if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory) || !Directory.Exists(directory))
                throw new InvalidDataException("目录选择器未返回有效的项目文件夹。");
            return directory;
        }
        finally
        {
            if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
            if (selected != null) Marshal.ReleaseComObject(selected);
            Marshal.ReleaseComObject(dialog);
        }
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    // Keep the native vtable order, including unused methods before GetResult.
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint location);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr value);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem item, uint hint, out int order);
    }
}

// Explorer can navigate through junctions and directory symlinks that point to another volume, but
// the workspace registry grants only canonical paths, so a folder picked through a link was refused. Resolve the pick
// the way Node's fs.realpathSync.native does (libuv: GetFinalPathNameByHandleW with VOLUME_NAME_DOS, then drop the
// \\?\ prefix or turn \\?\UNC\ into \\). The registry still applies every check to the resolved path; if anything
// here fails, the original path goes through unchanged and the registry decides.
internal static class RealDirectoryPath
{
    private const uint FileShareAll = 0x7;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint VolumeNameDos = 0;

    internal static string Resolve(string directory)
    {
        if (String.IsNullOrEmpty(directory)) return directory;
        try
        {
            using (SafeFileHandle handle = CreateFileW(directory, 0, FileShareAll, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics, IntPtr.Zero))
            {
                if (handle.IsInvalid) return directory;
                StringBuilder buffer = new StringBuilder(520);
                uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, VolumeNameDos);
                if (length >= buffer.Capacity)
                {
                    buffer = new StringBuilder((int)length + 1);
                    length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, VolumeNameDos);
                }
                if (length == 0 || length >= buffer.Capacity) return directory;
                string final = buffer.ToString(0, (int)length);
                if (final.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + final.Substring(8);
                if (final.StartsWith(@"\\?\", StringComparison.Ordinal)) return final.Substring(4);
                return directory;
            }
        }
        catch (Exception)
        {
            return directory;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}

internal sealed class LauncherPaths
{
    public string PackageRoot;
    public string RuntimePath;
    public string NodePath;
    public string AppPath;
    public string DesktopScriptPath;
    public string WebDistPath;
    public string ConfigPath;
    public string WorkPath;
    public string EdgeProfilePath;
    public string LogDirectory;
    public string LogPath;
    public string SmokeResultPath;
    public string SelfTestResultPath;
    public string EdgePath;

    public static LauncherPaths FromExecutable()
    {
        LauncherPaths paths = new LauncherPaths();
        paths.PackageRoot = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        paths.RuntimePath = Path.Combine(paths.PackageRoot, "runtime");
        paths.NodePath = Path.Combine(paths.RuntimePath, "node.exe");
        paths.AppPath = Path.Combine(paths.PackageRoot, "app");
        paths.DesktopScriptPath = Path.Combine(paths.AppPath, "desktop.mjs");
        paths.WebDistPath = Path.Combine(paths.AppPath, "web", "dist");
        paths.ConfigPath = Path.Combine(paths.AppPath, "config");
        paths.WorkPath = Path.Combine(paths.PackageRoot, "work");
        paths.EdgeProfilePath = Path.Combine(paths.WorkPath, "edge-profile");
        paths.LogDirectory = Path.Combine(paths.WorkPath, "logs");
        paths.LogPath = Path.Combine(paths.LogDirectory, "desktop-launcher.log");
        paths.SmokeResultPath = Path.Combine(paths.WorkPath, "smoke-result.json");
        paths.SelfTestResultPath = Path.Combine(paths.WorkPath, "self-test-result.json");
        paths.EdgePath = FindEdge();
        return paths;
    }

    private static string FindEdge()
    {
        string[] registryPaths =
        {
            @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
        };
        foreach (string key in registryPaths)
        {
            object value = Registry.GetValue(key, null, null);
            string path = value as string;
            if (!String.IsNullOrEmpty(path) && File.Exists(path)) return path;
        }

        string[] roots = { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) };
        foreach (string root in roots)
        {
            if (String.IsNullOrEmpty(root)) continue;
            string candidate = Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}

internal sealed class LauncherLog
{
    private readonly string path;
    private readonly object sync = new object();

    public LauncherLog(string path)
    {
        this.path = path;
    }

    public void Info(string message)
    {
        Write("INFO", message);
    }

    public void Error(string message, Exception exception)
    {
        Write("ERROR", message + ": " + exception.GetType().FullName + ": " + exception.Message);
    }

    private void Write(string level, string message)
    {
        try
        {
            lock (sync)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.AppendAllText(path, DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " " + level + " " + message + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch
        {
            // Logging must never create a secondary failure or dialog.
        }
    }
}

internal sealed class LauncherFailure : Exception
{
    public LauncherFailure(string message) : base(message) { }
}
