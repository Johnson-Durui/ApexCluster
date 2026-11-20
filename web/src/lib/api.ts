let session: Promise<string> | null = null;
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
async function decode<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { error: text || '服务未返回数据' }; }
  if (!response.ok) {
    if (response.status === 403) session = null;
    throw new ApiError((data as { error?: string }).error || `请求失败（${response.status}）`, response.status);
  }
  return data as T;
}
export function initSession(): Promise<string> {
  session ??= fetch('/api/session').then(decode<{token: string}>).then(data => data.token).catch(error => { session = null; throw error; });
  return session;
}
export const api = {
  get: <T,>(url: string, signal?: AbortSignal): Promise<T> => fetch(url, { signal }).then(decode<T>),
  async post<T>(url: string, body: unknown = {}): Promise<T> {
    const send = async () => {
      const token = await initSession();
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': token }, body: JSON.stringify(body) });
    };
    let response = await send();
    // A rejected token never reaches a mutation handler. Refresh once after a server restart.
    if (response.status === 403) { session = null; response = await send(); }
    return decode<T>(response);
  },
  async delete<T>(url: string, body: unknown = {}): Promise<T> {
    const send = async () => {
      const token = await initSession();
      return fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-workbench-token': token }, body: JSON.stringify(body) });
    };
    let response = await send();
    if (response.status === 403) { session = null; response = await send(); }
    return decode<T>(response);
  },
  async upload<T>(url: string, file: File): Promise<T> {
    const send = async () => {
      const token = await initSession();
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Reference-Name': encodeURIComponent(file.name),
          'X-Workbench-Token': token,
        },
        body: file,
      });
    };
    let response = await send();
    // A rejected token never reaches a mutation handler. Refresh once after a server restart.
    if (response.status === 403) { session = null; response = await send(); }
    return decode<T>(response);
  },
};
