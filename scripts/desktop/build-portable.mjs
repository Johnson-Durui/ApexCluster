import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolvePortableSources } from './portable-sources.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`缺少 ${name}`);
  return path.resolve(args[index + 1]);
}
const project = option('--project');
const output = option('--out');
const nodeFile = option('--node');
const launcherFile = option('--launcher');
const desktopResources = args.includes('--desktop-resources') ? option('--desktop-resources') : null;
const desktopHost = desktopResources ? JSON.parse(fs.readFileSync(path.join(desktopResources, 'desktop-host.json'), 'utf8').replace(/^\uFEFF/, '')) : null;
const includeData = args.includes('--include-data');
const chatCandidate = args.includes('--chat-candidate');
const chatStatusFile = args.includes('--chat-status') ? option('--chat-status') : null;
if (chatStatusFile && !chatCandidate) throw new Error('--chat-status 只能用于聊天候选包。');
const chatStatus = chatStatusFile ? JSON.parse(fs.readFileSync(chatStatusFile, 'utf8')) : {
  modelIsolation: 'unverified', realModelEndToEnd: 'not_run', nativeDesktop: 'not_verified', liveAuthorization: 'pending',
};
if (!chatStatus || typeof chatStatus !== 'object' || Array.isArray(chatStatus)
  || !['unverified', 'partial', 'verified'].includes(chatStatus.modelIsolation)
  || !['not_run', 'partial', 'verified'].includes(chatStatus.realModelEndToEnd)
  || !['not_verified', 'verified'].includes(chatStatus.nativeDesktop)
  || !['pending', 'granted'].includes(chatStatus.liveAuthorization)
  || (chatStatus.realModelCalls !== undefined && (!chatStatus.realModelCalls || Object.keys(chatStatus.realModelCalls).sort().join(',') !== 'astra,claude,grok,sol' || Object.values(chatStatus.realModelCalls).some(n => !Number.isSafeInteger(n) || n < 0)))) throw new Error('聊天发布状态格式无效。');
const upgradeIndex = args.indexOf('--upgrade-from');
const upgradeFrom = upgradeIndex >= 0 && args[upgradeIndex + 1] ? path.resolve(args[upgradeIndex + 1]) : null;
if (upgradeIndex >= 0 && !upgradeFrom) throw new Error('缺少 --upgrade-from 的目录');
if (includeData && upgradeFrom) throw new Error('--include-data 与 --upgrade-from 不能同时使用');
if (fs.existsSync(output)) throw new Error('输出目录已经存在，请选择新目录；不会覆盖现有数据。');
for (const required of [nodeFile, launcherFile, path.join(project, 'web/dist/index.html'), path.join(project, 'src/server/desktop.ts')]) {
  if (!fs.statSync(required).isFile()) throw new Error(`缺少打包文件：${required}`);
}

function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`打包不跟随符号链接：${file}`);
    if (entry.isDirectory()) return filesUnder(file);
    if (!entry.isFile()) throw new Error(`不支持的文件类型：${file}`);
    return [file];
  });
}
function copyFile(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
}
// v1 moved the dated release notes from docs/ into docs/history/; look in both.
function docSource(relative) {
  return [path.join(project, 'docs', relative), path.join(project, 'docs/history', path.basename(relative))].find(file => fs.existsSync(file));
}
function copyTree(source, dest) {
  const files = filesUnder(source);
  for (const file of files) copyFile(file, path.join(dest, path.relative(source, file)));
  return files;
}
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
const app = path.join(output, 'app');
const sourceRoot = path.join(project, 'src');
const sourceFiles = filesUnder(sourceRoot);
const sourceStartHashes = chatCandidate ? new Map(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])) : null;
const esbuild = await import(pathToFileURL(path.join(project, 'node_modules/esbuild/lib/main.js')).href);
fs.mkdirSync(app, { recursive: true });
await esbuild.build({
  entryPoints: sourceFiles.filter(file => file.endsWith('.ts')),
  outdir: path.join(app, 'src'), outbase: sourceRoot,
  bundle: false, platform: 'node', format: 'esm', target: 'node22',
  charset: 'utf8', logLevel: 'warning',
});
for (const file of sourceFiles.filter(file => !file.endsWith('.ts'))) {
  copyFile(file, path.join(app, 'src', path.relative(sourceRoot, file)));
}
if (chatCandidate) {
  const chatDir = path.join(app, 'src/chat');
  const sourceCs = path.join(chatDir, 'windows-job-supervisor.cs');
  const wrapperJs = path.join(chatDir, 'windows-job-process.js');
  const binary = path.join(chatDir, 'windows-job-supervisor.exe');
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  for (const file of [sourceCs, wrapperJs, compiler]) if (!fs.statSync(file).isFile()) throw new Error(`Windows Job supervisor 构建输入缺失：${file}`);
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${binary}`, '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', sourceCs], { cwd: project, stdio: 'inherit', windowsHide: true });
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  json(path.join(chatDir, 'windows-job-supervisor.manifest.json'), {
    protocol: 1,
    sourceCsSha256: sha256(sourceCs),
    wrapperSha256: sha256(wrapperJs),
    binarySha256: sha256(binary),
    compilerSha256: sha256(compiler),
  });
}
copyFile(path.join(project, 'scripts/desktop/desktop-entry.mjs'), path.join(app, 'desktop.mjs'));
json(path.join(app, 'package.json'), { name: 'dual-model-workbench-portable', private: true, type: 'module' });
copyTree(path.join(project, 'web/dist'), path.join(app, 'web/dist'));

// Ship runtime dependencies and their dependency closure; development tooling stays out.
// TypeScript, tsx and build tools are not required by the portable application.
const copiedPackages = new Map();
function copyPackage(name) {
  if (copiedPackages.has(name)) return;
  const packageDir = path.join(project, 'node_modules', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  copiedPackages.set(name, manifest.version);
  copyTree(packageDir, path.join(app, 'node_modules', name));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(dependency);
}
copyPackage('cross-spawn');
copyPackage('zod');
copyPackage('ajv');
if (fs.existsSync(path.join(project, 'compose.yaml'))) {
  copyFile(path.join(project, 'compose.yaml'), path.join(app, 'compose.yaml'));
  copyTree(path.join(project, 'services/document-worker'), path.join(app, 'services/document-worker'));
  copyFile(path.join(project, 'scripts/document-worker.ps1'), path.join(app, 'scripts/document-worker.ps1'));
  copyFile(path.join(project, 'tests/document-worker_smoke.py'), path.join(app, 'tests/document-worker_smoke.py'));
  fs.writeFileSync(path.join(output, '启动文档服务.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\\scripts\\document-worker.ps1" -Action up\r\nif errorlevel 1 pause\r\n', { flag: 'wx' });
}
await esbuild.build({ entryPoints: [path.join(project, 'scripts/chat-backup.ts')], outfile: path.join(app, 'scripts/chat-backup.js'), bundle: false, platform: 'node', format: 'esm', target: 'node22', charset: 'utf8' });
for (const name of ['COURSE_UPGRADE_20261104.md', 'COURSE_UPGRADE_ACCEPTANCE_20261104.md', 'HARNESS_COMPLETION_20261104.md', 'REFERENCE_COMPARISON_20261105.md', 'LONG_TASK_EXECUTION_CONTRACT_20261105.md', 'PROJECT_OUTPUT_AUTOSAVE_20261105.md']) {
  const file = docSource(name);
  if (file) copyFile(file, path.join(app, 'docs', name));
}
copyFile(nodeFile, path.join(output, 'runtime/node.exe'));
const nodeLicense = ['LICENSE', 'NODE-LICENSE.txt'].map(name => path.join(path.dirname(nodeFile), name)).find(file => fs.existsSync(file));
if (!nodeLicense) throw new Error('Node runtime license not found alongside executable.');
copyFile(nodeLicense, path.join(output, 'runtime/NODE-LICENSE.txt'));
copyFile(launcherFile, path.join(output, '双模型工作台.exe'));
if (desktopResources) copyTree(desktopResources, output);
copyFile(path.join(project, 'web/public/workbench.ico'), path.join(output, 'workbench.ico'));

const sources = resolvePortableSources({ project, includeData, upgradeFrom });
const config = sources.config;
const chatPortIndex = args.indexOf('--chat-port');
if (chatPortIndex >= 0) {
  const chatPort = Number(args[chatPortIndex + 1]);
  if (!chatCandidate || !Number.isInteger(chatPort) || chatPort < 1024 || chatPort > 65535) throw new Error('候选版端口应为1024–65535的整数。');
  config.port = chatPort;
}
const originalData = sources.dataSource;
const dataFiles = originalData && fs.existsSync(originalData) ? filesUnder(originalData) : [];
config.dataDir = '../data';
json(path.join(app, 'config/workbench.config.json'), config);
// v1 reads the model registry, roster and presets from app/config (API mode, and the settings view).
for (const name of ['models.registry.json', 'roster.json']) {
  const file = path.join(project, 'config', name);
  if (fs.existsSync(file)) copyFile(file, path.join(app, 'config', name));
}
if (fs.existsSync(path.join(project, 'config/presets'))) copyTree(path.join(project, 'config/presets'), path.join(app, 'config/presets'));
if (chatCandidate) {
  const settingsFile = path.join(project, 'config/chat.config.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : { dataRoot: '../data' };
  // v1 adds driverMode ('cli' | 'api'); paths stay plain strings.
  if (!settings || typeof settings !== 'object' || Object.keys(settings).some(key => !['dataRoot', 'capabilitiesFile', 'driverMode'].includes(key)) || Object.values(settings).some(value => typeof value !== 'string')
    || (settings.driverMode !== undefined && !['cli', 'api'].includes(settings.driverMode))) throw new Error('chat.config.json 只能包含 dataRoot/capabilitiesFile 字符串路径和 driverMode（cli/api）。');
  if (args.includes('--chat-data-root')) { settings.dataRoot = option('--chat-data-root'); delete settings.capabilitiesFile; }
  json(path.join(app, 'config/chat.config.json'), settings);
  const harnessFile = docSource('CHAT_HARNESS.md');
  if (!harnessFile) throw new Error('docs/CHAT_HARNESS.md (or docs/history/CHAT_HARNESS.md) not found.');
  copyFile(harnessFile, path.join(app, 'docs/CHAT_HARNESS.md'));
  const acceptanceFile = docSource('CHAT_ACCEPTANCE_20261027.md');
  if (acceptanceFile) copyFile(acceptanceFile, path.join(app, 'docs/CHAT_ACCEPTANCE_20261027.md'));
  for (const name of ['CHAT_HARNESS_APPROVED.md', 'CHAT_GROK_VERIFICATION_DECISION.md']) {
    const file = path.join(project, 'docs/plans', name);
    if (fs.existsSync(file)) copyFile(file, path.join(app, 'docs/plans', name));
  }
  if (chatStatusFile) copyFile(chatStatusFile, path.join(output, 'chat-build-evidence.json'));
  json(path.join(output, 'chat-release-status.json'), {
    ...chatStatus, edition: 'chat-candidate',
    ...(chatStatusFile ? { buildEvidenceSha256: createHash('sha256').update(fs.readFileSync(chatStatusFile)).digest('hex') } : {}),
    dataRoot: settings.dataRoot ?? '../data',
    note: chatStatus.note ?? '聊天界面与运行层候选。测试命令仅可使用与本机程序及策略哈希匹配的已验证执行端，缺证明时关闭；旧Run可独立使用。',
  });
}
fs.mkdirSync(path.join(output, 'data'), { recursive: true });
const imported = [];
for (const file of dataFiles) {
  const relative = path.relative(originalData, file);
  const dest = path.join(output, 'data', relative);
  copyFile(file, dest);
  const sourceHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const destHash = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  if (sourceHash !== destHash) throw new Error(`数据复制校验失败：${relative}`);
  imported.push({ path: relative, sha256: sourceHash, size: fs.statSync(dest).size });
}
json(path.join(output, 'data-import-manifest.json'), imported);

const notices = ['双模型工作台便携版 — 第三方许可', 'Node.js 许可见 runtime/NODE-LICENSE.txt。', '后端运行库在 app/node_modules 中保留原始许可证。'];
// Preserve licenses for the already-built frontend without shipping build tools.
const webModules = path.join(project, 'web/node_modules');
for (const top of fs.readdirSync(webModules, { withFileTypes: true })) {
  if (!top.isDirectory() || top.name.startsWith('.')) continue;
  const dirs = top.name.startsWith('@')
    ? fs.readdirSync(path.join(webModules, top.name), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(webModules, top.name, e.name))
    : [path.join(webModules, top.name)];
  for (const dir of dirs) {
    const licenses = fs.readdirSync(dir).filter(name => /^(LICEN[CS]E|COPYING|NOTICE)(\.|$|-)/i.test(name));
    for (const license of licenses) {
      const file = path.join(dir, license);
      if (fs.statSync(file).isFile()) notices.push(`\n===== ${path.relative(webModules, dir)} / ${license} =====\n`, fs.readFileSync(file, 'utf8'));
    }
  }
}
fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'), { flag: 'wx' });
json(path.join(output, 'build-info.json'), {
  application: '双模型工作台', edition: chatCandidate ? '聊天便携候选版' : '便携桌面版', createdAt: new Date().toISOString(),
  sourceProject: project, nodeVersion: process.version,
  runtimePackages: Object.fromEntries(copiedPackages),
  dataFilesCopied: imported.length, dataBytesCopied: imported.reduce((sum, f) => sum + f.size, 0),
  dataSourceKind: sources.dataSourceKind,
  configSource: sources.configSource,
  ...(desktopHost ? { desktopHost } : {}),
});
fs.writeFileSync(path.join(output, '使用说明.txt'), `双模型工作台 · 便携桌面版\r\n\r\n双击“ 双模型工作台.exe ”打开。请保留整个文件夹，不要单独移动 exe。\r\n无需安装 Node.js 或运行命令。界面使用本机 Edge 的独立应用窗口。\r\n\r\n启动和关闭\r\n- 只在双击时启动；不创建开机启动或计划任务。\r\n- 空闲时关闭窗口，工作台后台服务随之结束。\r\n- 有任务运行时会提示；取消退出可继续运行，确认退出才取消任务并关闭。\r\n- 重复双击会返回已打开的窗口。\r\n\r\n数据与模型\r\n- 历史记录和参考附件已复制到本文件夹 data；原项目保留。\r\n- 后续请使用这个便携版入口，原项目数据与这里不会自动同步。\r\n- 既有 Sol 构建工作区保留原路径，新工作区仍使用现有配置。\r\n- 模型继续调用本机已安装并登录的 Claude Code 和 Codex；不会打包登录凭证。\r\n- 本电脑可直接使用；换电脑时需要安装 Edge、相应模型 CLI 并登录，再调整 app/config/workbench.config.json 中的 CLI 路径。\r\n- 关闭状态不占用工作台服务资源；模型调用仍需联网。\r\n\r\n排错\r\n日志位于 work/logs。端口被占用时会报错，不接管或停止其他服务。\r\n专用 Edge 窗口数据位于 work/edge-profile，不使用日常浏览器配置。\r\n`, { flag: 'wx' });
if (chatCandidate) {
  const guide = path.join(output, '使用说明.txt');
  const accepted = chatStatus.modelIsolation === 'verified' && chatStatus.realModelEndToEnd === 'verified' && chatStatus.nativeDesktop === 'verified';
  const notice = `聊天便携候选版（${accepted ? '验收证据见发布状态' : '完整验收尚未完成'}）\r\n\r\n默认进入聊天；聊天数据目录见 app/config/chat.config.json，原项目不搬迁。\r\n实际授权、模型与桌面验收状态见 chat-release-status.json；测试runner仅载入与当前程序及策略一致的本机隔离证明，缺失或漂移时显示不可用原因。\r\n完整状态见 chat-release-status.json 与 app/docs/CHAT_HARNESS.md。此包不替换现有最新版入口。\r\n旧 Run 历史通过“任务历史”访问。\r\n课程升级说明见 app/docs/COURSE_UPGRADE_20261104.md。安装并启动 Docker Desktop 后，双击“启动文档服务.cmd”启用文档、Office 和图像校验服务。\r\n\r\n`;
  const candidateGuide = fs.readFileSync(guide, 'utf8')
    .replace('- 历史记录和参考附件已复制到本文件夹 data；原项目保留。', '- 新聊天使用 app/config/chat.config.json 中的独立数据目录；包内 data 仅用于旧 Run 数据，原项目保留。')
    .replace('- 后续请使用这个便携版入口，原项目数据与这里不会自动同步。', '- 验收完成前保留原日常入口；候选数据与原日常数据不会自动同步。')
    .replace('- 本电脑可直接使用；换电脑时需要安装 Edge、相应模型 CLI 并登录，再调整 app/config/workbench.config.json 中的 CLI 路径。', '- 模型是否可用以当前候选的验证状态为准；换电脑后需要重新安装、登录并完成本机能力验证。');
  fs.writeFileSync(guide, notice + candidateGuide, 'utf8');
  const digestFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const currentSources = filesUnder(sourceRoot);
  if (currentSources.length !== sourceFiles.length || currentSources.some(file => sourceStartHashes.get(file) !== digestFile(file))) throw new Error('打包过程中源文件发生变化，请在修改结束后重新构建候选。');
  json(path.join(output, 'chat-source-manifest.json'), {
    source: sourceFiles.map(file => ({ path: path.relative(sourceRoot, file).replaceAll('\\', '/'), sha256: digestFile(file) })),
    application: filesUnder(app).map(file => ({ path: path.relative(app, file).replaceAll('\\', '/'), sha256: digestFile(file) })),
    launcherSha256: digestFile(path.join(output, '双模型工作台.exe')),
    nodeSha256: digestFile(path.join(output, 'runtime/node.exe')),
    runners: {
      windows: { module: 'src/chat/runner-windows.js', sha256: digestFile(path.join(app, 'src/chat/runner-windows.js')), proofFile: 'capabilities/runner-windows.json' },
      linux: { module: 'src/chat/runner-wsl.js', sha256: digestFile(path.join(app, 'src/chat/runner-wsl.js')), runtime: 'src/chat/wsl-test-runtime.mjs', runtimeSha256: digestFile(path.join(app, 'src/chat/wsl-test-runtime.mjs')), proofFile: 'capabilities/runner-wsl.json' },
      policy: '生产只载入绑定实际模块、隔离工具和策略的实测证明；TypeScript与打包JavaScript必须分别验证。',
    },
  });
}
if (desktopHost) {
  const digestFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const resources = filesUnder(desktopResources).map(file => path.relative(desktopResources, file));
  json(path.join(output, 'desktop-host-manifest.json'), {
    ...desktopHost,
    launcherSha256: digestFile(path.join(output, '双模型工作台.exe')),
    files: resources.map(file => ({ path: file.replaceAll('\\', '/'), sha256: digestFile(path.join(output, file)) })),
  });
  const guide = path.join(output, '使用说明.txt');
  fs.writeFileSync(guide, fs.readFileSync(guide, 'utf8')
    .replace('界面使用本机 Edge 的独立应用窗口。', '界面由本程序的独立 Windows 窗口承载，内嵌 WebView2；不会打开外部 Edge 窗口。')
    .replace('需要安装 Edge、相应模型 CLI', '需要 .NET Framework 4.8、Microsoft Edge WebView2 Runtime、相应模型 CLI')
    .replace('专用 Edge 窗口数据位于 work/edge-profile，不使用日常浏览器配置。', '桌面窗口数据位于 work/webview2-profile，不使用日常浏览器配置。')
    + `\r\n桌面版运行要求：Windows 10/11 x64、${desktopHost.framework}、WebView2 Evergreen Runtime。模型 CLI 与 Docker 文档服务仍按原有配置工作。\r\nWebView2 SDK 许可见 WEBVIEW2-SDK-LICENSE.txt，宿主文件清单见 desktop-host-manifest.json。\r\n`, 'utf8');
}
console.log(JSON.stringify({ output, dataFiles: imported.length, dataBytes: imported.reduce((s, f) => s + f.size, 0), packages: Object.fromEntries(copiedPackages), chatCandidate }));
