import type { ReferenceArchive, ReferenceDocument } from '../lib/types';
import './reference-documents.css';

export function ReferenceDocumentList({ documents = [], archives = [] }: { documents?: ReferenceDocument[]; archives?: ReferenceArchive[] }) {
  if (!documents.length && !archives.length) return null;
  return <section className="reference-documents" aria-label="参考文档">
    <h3>参考资料（{documents.length} 份文档，{archives.length} 个 ZIP）</h3>
    <p className="muted">随此版本需求保存的参考资料。</p>
    {documents.map(document => <details key={document.name}>
      <summary><span>{document.name}</span><small>{document.content.length.toLocaleString()} 字符</small></summary>
      <pre>{document.content}</pre>
    </details>)}
    {archives.map(archive => <details key={archive.id}>
      <summary><span>{archive.name}</span><small>{(archive.size / 1024 / 1024).toFixed(2)} MB · 已展开 {archive.files.length} 个文件 · 原包已保留</small></summary>
      {archive.notes.map((note, index) => <p className="alert warn" key={index}>{note}</p>)}
      <pre>{archive.files.map(file => `${file.name}（${file.size.toLocaleString()} 字节）`).join('\n') || '未展开文件；原始 ZIP 仍会提供给模型。'}</pre>
    </details>)}
  </section>;
}
