import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api } from '../../lib/api';
import type { ReferenceArchive, ReferenceDocument } from '../../lib/types';
import {
  formatBytes,
  formatCount,
  canonicalReferenceName,
  mergeReferenceDocuments,
  mergeReferenceArchives,
  normalizeReferenceName,
  validateUpload,
  type ReferenceLimits,
} from './referenceDocuments';

interface ImportResult { documents: ReferenceDocument[]; archives: ReferenceArchive[]; skipped: string[] }
interface UploadItem { id: number; file: File; status: 'pending' | 'uploading' | 'uploaded' | 'failed'; error: string }

interface Props {
  documents: ReferenceDocument[];
  archives: ReferenceArchive[];
  limits: ReferenceLimits;
  onDocumentsChange: (documents: ReferenceDocument[]) => void;
  onArchivesChange: (archives: ReferenceArchive[]) => void;
  onBusyChange: (busy: boolean) => void;
  onBlockingErrorChange: (hasError: boolean) => void;
}

export function ReferenceDocumentsEditor({ documents, archives, limits, onDocumentsChange, onArchivesChange, onBusyChange, onBlockingErrorChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const documentsRef = useRef(documents);
  const archivesRef = useRef(archives);
  const importingRef = useRef(false);
  const [name, setName] = useState('参考文档.txt');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadId = useRef(0);
  const totalChars = documents.reduce((sum, item) => sum + item.content.length, 0);

  useEffect(() => { documentsRef.current = documents; }, [documents]);
  useEffect(() => { archivesRef.current = archives; }, [archives]);
  useEffect(() => { onBlockingErrorChange(Boolean(error) || uploads.some(item => item.status === 'failed' || item.status === 'pending')); }, [error, uploads, onBlockingErrorChange]);

  function reportError(message: string) {
    setError(message);
    setNotice('');
    onBlockingErrorChange(Boolean(message));
  }

  function commit(incomingDocuments: ReferenceDocument[], incomingArchives: ReferenceArchive[] = [], skipped: string[] = []) {
    const nextDocuments = mergeReferenceDocuments(documentsRef.current, incomingDocuments, limits);
    const nextArchives = mergeReferenceArchives(archivesRef.current, incomingArchives, limits);
    documentsRef.current = nextDocuments;
    archivesRef.current = nextArchives;
    onDocumentsChange(nextDocuments);
    onArchivesChange(nextArchives);
    reportError('');
    const added = [incomingDocuments.length ? `${incomingDocuments.length} 份文档` : '', incomingArchives.length ? `${incomingArchives.length} 个 ZIP 资料包` : ''].filter(Boolean).join('和');
    setNotice(skipped.length ? `已加入${added}；未能处理：${skipped.join('、')}` : `已加入${added}`);
  }

  function addPasted() {
    try {
      commit([{ name: normalizeReferenceName(name), content }]);
      setName('参考文档.txt');
      setContent('');
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : '添加文档失败');
    }
  }

  async function importSelected(items: UploadItem[]) {
    const files = items.map(item => item.file);
    if (!files.length) return;
    if (importingRef.current) { reportError('已有参考资料正在读取，请稍候。'); return; }
    const rejectSelection = (message: string) => { reportError(message); setUploads(previous => previous.map(value => items.some(item => item.id === value.id) ? { ...value, status: 'failed', error: message } : value)); };
    const localIssue = files.map(file => validateUpload(file, limits)).find(Boolean);
    if (localIssue) { rejectSelection(localIssue); return; }
    const names = new Set([...documentsRef.current, ...archivesRef.current].map(item => canonicalReferenceName(item.name)));
    for (const file of files) {
      const key = canonicalReferenceName(file.name);
      if (names.has(key)) { rejectSelection(`资料名称重复：${file.name}。请移除重复项或重命名文件后再添加。`); return; }
      names.add(key);
    }
    const zipCount = files.filter(file => file.name.toLocaleLowerCase().endsWith('.zip')).length;
    const documentCount = files.length - zipCount;
    if (archivesRef.current.length + zipCount > limits.maxArchives) { rejectSelection(`ZIP 资料包最多 ${limits.maxArchives} 个`); return; }
    if (documentsRef.current.length + documentCount > limits.maxDocuments) { rejectSelection(`参考文档最多 ${limits.maxDocuments} 份`); return; }
    importingRef.current = true;
    setBusy(true);
    onBusyChange(true);
    reportError('');
    try {
      for (const item of items) {
        const update = (status: UploadItem['status'], message = '') => setUploads(previous => previous.map(value => value.id === item.id ? { ...value, status, error: message } : value));
        update('uploading');
        try {
          const file = item.file;
          const result = file.name.toLocaleLowerCase().endsWith('.zip')
            ? await api.upload<ImportResult>('/api/reference-archives/import', file)
            : await api.post<ImportResult>('/api/reference-documents/import', { name: file.name, contentBase64: await readFileAsBase64(file) });
          // 每份成功后立即保留，后续文件失败不会丢失此前的附件。
          commit(result.documents, result.archives, result.skipped);
          update('uploaded');
        } catch (cause) {
          update('failed', cause instanceof Error ? cause.message : '读取参考资料失败');
        }
      }
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : '读取参考文档失败');
    } finally {
      importingRef.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (importingRef.current || !files.length) return;
    const items: UploadItem[] = files.map(file => ({ id: ++uploadId.current, file, status: 'pending', error: '' }));
    setUploads(previous => [...previous, ...items]);
    void importSelected(items);
  }

  /** After 删除 / 移除 focus moves to the same control on the next row, else to 选择文档或 ZIP (never to <body>). */
  function focusNextRow(from: HTMLElement, selector: string) {
    const row = from.closest('article, li');
    const next = row?.nextElementSibling?.querySelector<HTMLElement>(selector) ?? null;
    window.requestAnimationFrame(() => ((next?.isConnected ? next : null) ?? addRef.current)?.focus());
  }

  function removeDocument(index: number, from: HTMLElement) {
    focusNextRow(from, 'button.danger');
    const next = documentsRef.current.filter((_, itemIndex) => itemIndex !== index);
    documentsRef.current = next;
    onDocumentsChange(next);
    reportError('');
    setNotice('');
  }

  function removeArchive(index: number, from: HTMLElement) {
    focusNextRow(from, 'button.danger');
    const next = archivesRef.current.filter((_, itemIndex) => itemIndex !== index);
    archivesRef.current = next;
    onArchivesChange(next);
    reportError('');
    setNotice('');
  }

  return <div className="reference-editor" id="new-references">
    <div className="reference-head">
      <div><h3>参考资料 <span className="muted">（可选）</span></h3><p className="help-note">Markdown 和文本可直接预览；ZIP 会作为完整资料包保存，包内文档、代码、图片、PDF 等不会按格式过滤。</p></div>
      <div className="reference-count" aria-live="polite"><strong>{documents.length}</strong> / {limits.maxDocuments} 份文档 · <strong>{archives.length}</strong> / {limits.maxArchives} 个资料包 · <strong>{formatCount(totalChars)}</strong> / {formatCount(limits.maxTotalChars)} 字符</div>
    </div>
    <div className="reference-actions">
      <input ref={inputRef} className="sr-only" tabIndex={-1} aria-hidden="true" type="file" accept=".md,.txt,.zip,text/plain,text/markdown,application/zip" multiple onChange={importFiles} />
      <button ref={addRef} type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? '正在导入…' : '选择文档或 ZIP'}</button>
      <span className="muted">每个文档最多 {formatCount(limits.maxDocumentChars)} 字符；ZIP 会流式保存到磁盘，不设上传大小上限</span>
    </div>
    {uploads.length ? <ul className="reference-upload-queue" aria-label="附件导入状态" aria-live="polite">{uploads.map(item => <li key={item.id} className={`upload-${item.status}`}><div><b>{item.file.name}</b><span>{item.status === 'pending' ? '待导入' : item.status === 'uploading' ? '正在上传并处理…' : item.status === 'uploaded' ? '已导入' : '导入失败 · 未加入任务'}</span>{item.error ? <p>{item.error}</p> : null}</div>{item.status === 'failed' || item.status === 'pending' && !busy ? <div className="row"><button type="button" className="compact" disabled={busy} onClick={() => void importSelected([item])}>重试</button><button type="button" className="compact" disabled={busy} onClick={event => { focusNextRow(event.currentTarget, 'button'); setUploads(previous => previous.filter(value => value.id !== item.id)); reportError(''); }}>移除</button></div> : null}</li>)}</ul> : null}
    <details className="reference-paste">
      <summary>直接粘贴一份文档</summary>
      <div className="form-grid">
        <label className="field"><span>文档名称</span><input value={name} onChange={event => setName(event.target.value)} placeholder="参考文档.txt" /></label>
        <div className="reference-paste-note">名称需以 .md 或 .txt 结尾</div>
      </div>
      <label className="field"><span>文档正文</span><textarea rows={7} value={content} onChange={event => setContent(event.target.value)} placeholder="粘贴需求说明、接口约定或已有项目背景…" /></label>
      <button type="button" onClick={addPasted} disabled={busy}>加入清单</button>
    </details>
    {error ? <div className="alert bad reference-message reference-error" role="alert"><span>{error}</span><button type="button" onClick={() => reportError('')}>清除错误</button></div> : null}
    {notice ? <div className="alert info reference-message" role="status">{notice}</div> : null}
    {documents.length ? <div className="reference-list">{documents.map((document, index) => <article className="reference-item" key={document.name}>
      <div className="reference-item-head"><div><strong>{document.name}</strong><small>{formatCount(document.content.length)} 字符</small></div><button type="button" className="danger" disabled={busy} onClick={event => removeDocument(index, event.currentTarget)}>删除</button></div>
      <details><summary>展开纯文本预览</summary><pre>{document.content}</pre></details>
    </article>)}</div> : <p className="reference-empty">还没有参考文档。没有文档也可以继续创建需求。</p>}
    {archives.length ? <div className="reference-list archive-list">{archives.map((archive, index) => <article className="reference-item archive-item" key={archive.id}>
      <div className="reference-item-head"><div><strong>{archive.name}</strong><small>{formatBytes(archive.size)} · {archive.files.length} 个文件</small></div><button type="button" className="danger" disabled={busy} onClick={event => removeArchive(index, event.currentTarget)}>删除</button></div>
      {archive.notes.length ? <ul className="archive-notes">{archive.notes.map((note, noteIndex) => <li key={noteIndex}>{note}</li>)}</ul> : null}
      <details><summary>展开文件清单</summary><div className="archive-files">{archive.files.map((file, fileIndex) => <div key={`${file.path}-${fileIndex}`}><span>{file.name}</span><small>{formatBytes(file.size)}</small></div>)}</div></details>
    </article>)}</div> : null}
    <p className="help-note reference-privacy">资料保存在本机工作台中；创建运行后，AI 会收到已展开资料和原始 ZIP。遇到无法解析的格式时，AI 会在结果中说明。</p>
  </div>;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`读取 ${file.name} 失败`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) { reject(new Error(`读取 ${file.name} 失败`)); return; }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
