using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class DesktopAppWindow : Form
{
    private readonly string _url;
    private readonly string _origin;
    private readonly string _profileDirectory;
    private readonly string _downloadDirectory;
    private readonly Action<string> _log;
    private readonly WebView2 _webView;
    private readonly ToolStripStatusLabel _statusLabel;
    private readonly CancellationTokenSource _lifetimeCancellation;
    private readonly object _pendingDownloadsLock;
    private readonly List<PendingDownload> _pendingDownloads;
    private Icon _applicationIcon;
    private TaskCompletionSource<bool> _initialNavigation;
    private bool _initializationStarted;
    private bool _closeAfterStop;
    private bool _eventsAttached;
    private bool _resourcesDisposed;

    public DesktopAppWindow(
        string url,
        string profileDirectory,
        string downloadDirectory,
        Action<string> log)
    {
        Uri parsedUrl;
        if (!Uri.TryCreate(url, UriKind.Absolute, out parsedUrl) ||
            !IsHttp(parsedUrl) ||
            !parsedUrl.IsLoopback ||
            !String.IsNullOrEmpty(parsedUrl.UserInfo))
        {
            throw new ArgumentException("The desktop URL must be an absolute loopback HTTP or HTTPS URL.", "url");
        }

        if (String.IsNullOrWhiteSpace(profileDirectory))
        {
            throw new ArgumentException("A WebView2 profile directory is required.", "profileDirectory");
        }

        if (String.IsNullOrWhiteSpace(downloadDirectory))
        {
            throw new ArgumentException("A download directory is required.", "downloadDirectory");
        }

        if (log == null)
        {
            throw new ArgumentNullException("log");
        }

        _url = parsedUrl.AbsoluteUri;
        _origin = parsedUrl.GetLeftPart(UriPartial.Authority);
        _profileDirectory = Path.GetFullPath(profileDirectory);
        _downloadDirectory = Path.GetFullPath(downloadDirectory);
        _log = log;
        _lifetimeCancellation = new CancellationTokenSource();
        _pendingDownloadsLock = new object();
        _pendingDownloads = new List<PendingDownload>();

        Text = "多Agent工作台";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1200, 820);
        MinimumSize = new Size(900, 620);
        FormBorderStyle = FormBorderStyle.Sizable;

        try
        {
            _applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (_applicationIcon != null)
            {
                Icon = _applicationIcon;
            }
        }
        catch (Exception exception)
        {
            Log("无法读取应用图标：" + exception.Message);
        }

        _webView = new WebView2();
        _webView.Dock = DockStyle.Fill;
        _webView.AccessibleName = "多Agent工作台，地址 " + _origin;

        StatusStrip statusStrip = new StatusStrip();
        _statusLabel = new ToolStripStatusLabel();
        _statusLabel.Spring = true;
        _statusLabel.TextAlign = ContentAlignment.MiddleLeft;
        _statusLabel.Text = "正在启动…";
        statusStrip.Items.Add(_statusLabel);

        Controls.Add(_webView);
        Controls.Add(statusStrip);
        FormClosing += OnFormClosing;
    }

    public event EventHandler CloseRequested;

    public event Action<string> FatalError;

    public async Task InitializeAsync()
    {
        if (_initializationStarted)
        {
            throw new InvalidOperationException("The desktop window has already been initialized.");
        }

        _initializationStarted = true;
        _initialNavigation = new TaskCompletionSource<bool>();
        SetStatus("正在启动 WebView2…");

        try
        {
            Directory.CreateDirectory(_profileDirectory);
            Directory.CreateDirectory(_downloadDirectory);

            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                null,
                _profileDirectory,
                null);

            _lifetimeCancellation.Token.ThrowIfCancellationRequested();
            await _webView.EnsureCoreWebView2Async(environment);
            _lifetimeCancellation.Token.ThrowIfCancellationRequested();

            ConfigureCoreWebView2(_webView.CoreWebView2);
            AttachCoreEvents(_webView.CoreWebView2);
            SetStatus("正在连接 " + _origin + "…");
            _webView.Source = new Uri(_url);

            Task timeoutTask = Task.Delay(TimeSpan.FromSeconds(30), _lifetimeCancellation.Token);
            Task completedTask = await Task.WhenAny(_initialNavigation.Task, timeoutTask);
            if (completedTask == timeoutTask)
            {
                _lifetimeCancellation.Token.ThrowIfCancellationRequested();
                throw new TimeoutException("等待工作台页面加载超时（30 秒）。");
            }

            await _initialNavigation.Task;
            SetStatus("已连接 " + _origin);
            Log("桌面窗口已连接：" + _url);
        }
        catch (Exception exception)
        {
            if (!IsDisposed && !_lifetimeCancellation.IsCancellationRequested)
            {
                SetStatus("启动失败：" + exception.Message);
            }

            Log("桌面窗口初始化失败：" + exception.Message);
            throw;
        }
    }

    public void CloseAfterStop()
    {
        if (IsDisposed)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action(CloseAfterStop));
            }
            catch (InvalidOperationException)
            {
            }
            return;
        }

        _closeAfterStop = true;
        _lifetimeCancellation.Cancel();
        Close();
    }

    public void ActivateApplication()
    {
        if (IsDisposed)
        {
            return;
        }

        if (InvokeRequired)
        {
            try
            {
                BeginInvoke(new Action(ActivateApplication));
            }
            catch (InvalidOperationException)
            {
            }
            return;
        }

        if (!Visible)
        {
            Show();
        }
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }

        BringToFront();
        Activate();
    }

    public void SetStatus(string text)
    {
        if (_statusLabel != null && !_statusLabel.IsDisposed)
        {
            _statusLabel.Text = text ?? String.Empty;
        }
    }

    public static bool IsAllowedNavigation(string origin, string target)
    {
        Uri originUri;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out originUri) ||
            !IsHttp(originUri) ||
            !originUri.IsLoopback ||
            !String.IsNullOrEmpty(originUri.UserInfo))
        {
            return false;
        }

        if (String.IsNullOrWhiteSpace(target))
        {
            return false;
        }

        Uri targetUri;
        if (!Uri.TryCreate(target, UriKind.Absolute, out targetUri) ||
            !IsHttp(targetUri) ||
            !String.IsNullOrEmpty(targetUri.UserInfo))
        {
            return false;
        }

        return String.Equals(originUri.Scheme, targetUri.Scheme, StringComparison.OrdinalIgnoreCase) &&
               String.Equals(originUri.Host, targetUri.Host, StringComparison.OrdinalIgnoreCase) &&
               originUri.Port == targetUri.Port;
    }

    public static bool IsAllowedFrameNavigation(string origin, string target)
    {
        // A bundled srcDoc inherits the trusted page's origin; top-level navigation stays HTTP-only.
        if (String.Equals(target, "about:srcdoc", StringComparison.Ordinal))
        {
            return IsAllowedNavigation(origin, origin);
        }
        return IsAllowedNavigation(origin, target);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_resourcesDisposed)
        {
            _resourcesDisposed = true;
            _lifetimeCancellation.Cancel();
            if (_initialNavigation != null)
            {
                _initialNavigation.TrySetCanceled();
            }

            FormClosing -= OnFormClosing;
            DetachCoreEvents();
            CompletePendingDownloads();
            _webView.Dispose();
            if (_applicationIcon != null)
            {
                Icon = null;
                _applicationIcon.Dispose();
            }
            _applicationIcon = null;
            _lifetimeCancellation.Dispose();
        }

        base.Dispose(disposing);
    }

    private static bool IsHttp(Uri uri)
    {
        return String.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
               String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsAllowedDownload(string origin, string target)
    {
        if (String.IsNullOrWhiteSpace(target))
        {
            return false;
        }

        if (!target.StartsWith("blob:", StringComparison.OrdinalIgnoreCase))
        {
            return IsAllowedNavigation(origin, target);
        }

        return IsAllowedNavigation(origin, target.Substring("blob:".Length));
    }

    private void ConfigureCoreWebView2(CoreWebView2 core)
    {
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
    }

    private void AttachCoreEvents(CoreWebView2 core)
    {
        core.NavigationStarting += OnNavigationStarting;
        core.FrameNavigationStarting += OnFrameNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += OnNewWindowRequested;
        core.PermissionRequested += OnPermissionRequested;
        core.DownloadStarting += OnDownloadStarting;
        core.ProcessFailed += OnProcessFailed;
        _eventsAttached = true;
    }

    private void DetachCoreEvents()
    {
        if (!_eventsAttached || _webView.CoreWebView2 == null)
        {
            return;
        }

        CoreWebView2 core = _webView.CoreWebView2;
        core.NavigationStarting -= OnNavigationStarting;
        core.FrameNavigationStarting -= OnFrameNavigationStarting;
        core.NavigationCompleted -= OnNavigationCompleted;
        core.NewWindowRequested -= OnNewWindowRequested;
        core.PermissionRequested -= OnPermissionRequested;
        core.DownloadStarting -= OnDownloadStarting;
        core.ProcessFailed -= OnProcessFailed;
        _eventsAttached = false;
    }

    private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
    {
        if (_closeAfterStop)
        {
            return;
        }

        eventArgs.Cancel = true;
        SetStatus("正在安全关闭…");
        EventHandler handler = CloseRequested;
        if (handler != null)
        {
            handler(this, EventArgs.Empty);
        }
    }

    private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs eventArgs)
    {
        if (!IsAllowedNavigation(_origin, eventArgs.Uri))
        {
            eventArgs.Cancel = true;
            Log("已阻止外部导航：" + eventArgs.Uri);
        }
    }

    private void OnFrameNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs eventArgs)
    {
        if (!IsAllowedFrameNavigation(_origin, eventArgs.Uri))
        {
            eventArgs.Cancel = true;
            Log("已阻止框架导航：" + eventArgs.Uri);
        }
    }

    private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs eventArgs)
    {
        if (_initialNavigation == null || _initialNavigation.Task.IsCompleted)
        {
            if (!eventArgs.IsSuccess)
            {
                SetStatus("页面加载失败：" + eventArgs.WebErrorStatus);
                Log("页面导航失败：" + eventArgs.WebErrorStatus);
            }
            return;
        }

        if (eventArgs.IsSuccess &&
            _webView.Source != null &&
            IsAllowedNavigation(_origin, _webView.Source.AbsoluteUri))
        {
            _initialNavigation.TrySetResult(true);
            return;
        }

        InvalidOperationException exception = new InvalidOperationException(
            "工作台页面加载失败：" + eventArgs.WebErrorStatus);
        _initialNavigation.TrySetException(exception);
    }

    private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs eventArgs)
    {
        eventArgs.Handled = true;
        Log("已阻止新窗口：" + eventArgs.Uri);
    }

    private void OnPermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs eventArgs)
    {
        eventArgs.State = CoreWebView2PermissionState.Deny;
        eventArgs.Handled = true;
        Log("已拒绝页面权限：" + eventArgs.PermissionKind);
    }

    private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs eventArgs)
    {
        string message = "WebView2 进程失败：" + eventArgs.ProcessFailedKind;
        SetStatus(message);
        Log(message);
        if (_initialNavigation != null)
        {
            _initialNavigation.TrySetException(new InvalidOperationException(message));
        }

        if (eventArgs.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited ||
            eventArgs.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
        {
            try
            {
                BeginInvoke(new Action(delegate
                {
                    if (IsDisposed || Disposing)
                    {
                        return;
                    }

                    Action<string> handler = FatalError;
                    if (handler != null)
                    {
                        handler(message);
                    }
                }));
            }
            catch (InvalidOperationException)
            {
            }
        }
    }

    private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs eventArgs)
    {
        PendingDownload pendingDownload = new PendingDownload(eventArgs, eventArgs.GetDeferral());
        if (!RegisterPendingDownload(pendingDownload))
        {
            pendingDownload.CancelAndComplete();
            return;
        }
        if (!IsAllowedDownload(_origin, eventArgs.DownloadOperation.Uri))
        {
            eventArgs.Cancel = true;
            eventArgs.Handled = true;
            Log("已阻止非同源下载：" + eventArgs.DownloadOperation.Uri);
            FinishPendingDownload(pendingDownload);
            return;
        }

        try
        {
            BeginInvoke(new Action(delegate
            {
                try
                {
                    CompleteDownload(eventArgs);
                }
                catch (Exception exception)
                {
                    eventArgs.Cancel = true;
                    eventArgs.Handled = true;
                    Log("下载保存失败：" + exception.Message);
                }
                finally
                {
                    FinishPendingDownload(pendingDownload);
                }
            }));
        }
        catch (InvalidOperationException)
        {
            eventArgs.Cancel = true;
            eventArgs.Handled = true;
            FinishPendingDownload(pendingDownload);
        }
    }

    private bool RegisterPendingDownload(PendingDownload pendingDownload)
    {
        lock (_pendingDownloadsLock)
        {
            if (_resourcesDisposed)
            {
                return false;
            }

            _pendingDownloads.Add(pendingDownload);
            return true;
        }
    }

    private void FinishPendingDownload(PendingDownload pendingDownload)
    {
        lock (_pendingDownloadsLock)
        {
            _pendingDownloads.Remove(pendingDownload);
        }

        pendingDownload.Complete();
    }

    private void CompletePendingDownloads()
    {
        PendingDownload[] pendingDownloads;
        lock (_pendingDownloadsLock)
        {
            pendingDownloads = _pendingDownloads.ToArray();
            _pendingDownloads.Clear();
        }

        foreach (PendingDownload pendingDownload in pendingDownloads)
        {
            pendingDownload.CancelAndComplete();
        }
    }

    private void CompleteDownload(CoreWebView2DownloadStartingEventArgs eventArgs)
    {
        if (IsDisposed || Disposing)
        {
            eventArgs.Cancel = true;
            eventArgs.Handled = true;
            return;
        }

        string suggestedName = Path.GetFileName(eventArgs.DownloadOperation.ResultFilePath);
        if (String.IsNullOrWhiteSpace(suggestedName))
        {
            suggestedName = "download";
        }

        using (SaveFileDialog dialog = new SaveFileDialog())
        {
            dialog.Title = "保存下载文件";
            dialog.InitialDirectory = _downloadDirectory;
            dialog.FileName = suggestedName;
            dialog.Filter = "所有文件 (*.*)|*.*";
            dialog.OverwritePrompt = true;

            if (dialog.ShowDialog(this) != DialogResult.OK)
            {
                eventArgs.Cancel = true;
                eventArgs.Handled = true;
                return;
            }

            eventArgs.ResultFilePath = dialog.FileName;
            eventArgs.Handled = true;
            Log("下载已保存到：" + dialog.FileName);
        }
    }

    private void Log(string message)
    {
        try
        {
            _log(message);
        }
        catch
        {
        }
    }

    private sealed class PendingDownload
    {
        private readonly CoreWebView2DownloadStartingEventArgs _eventArgs;
        private readonly CoreWebView2Deferral _deferral;
        private int _completed;

        public PendingDownload(
            CoreWebView2DownloadStartingEventArgs eventArgs,
            CoreWebView2Deferral deferral)
        {
            _eventArgs = eventArgs;
            _deferral = deferral;
        }

        public void Complete()
        {
            if (Interlocked.Exchange(ref _completed, 1) == 0)
            {
                try
                {
                    _deferral.Complete();
                }
                catch
                {
                }
            }
        }

        public void CancelAndComplete()
        {
            if (Interlocked.Exchange(ref _completed, 1) != 0)
            {
                return;
            }

            try
            {
                _eventArgs.Cancel = true;
                _eventArgs.Handled = true;
            }
            catch
            {
            }
            finally
            {
                try
                {
                    _deferral.Complete();
                }
                catch
                {
                }
            }
        }
    }
}
