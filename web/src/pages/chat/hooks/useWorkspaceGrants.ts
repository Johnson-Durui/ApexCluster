// Workspace grants and global capabilities: the authorised project directories, the OS folder picker (polled every
// 700ms until chosen), and revoke. Errors are reported through `onError` (the composer strip). `choose` resolves to
// true only when a folder was picked and selected, so the project popover can close itself (as the baseline did).
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi, type ChatCapabilities, type WorkspaceGrant } from '../../../lib/chat-api';
import { explain } from './explain';

export function useWorkspaceGrants(onError: (message: string) => void) {
  const [workspaces, setWorkspaces] = useState<WorkspaceGrant[]>([]);
  const [globalCapabilities, setGlobalCapabilities] = useState<ChatCapabilities | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const pickerAbort = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener('workbench:capabilities-changed', changed);
    return () => window.removeEventListener('workbench:capabilities-changed', changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([chatApi.workspaces(controller.signal), chatApi.capabilities(controller.signal)]).then(([grants, capabilities]) => {
      if (controller.signal.aborted) return;
      if (grants.status === 'fulfilled') setWorkspaces(grants.value.filter(item => item.active));
      if (capabilities.status === 'fulfilled') setGlobalCapabilities(capabilities.value);
    });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => () => pickerAbort.current?.abort(), []);

  const choose = useCallback(async (): Promise<boolean> => {
    if (busy || (pickerAbort.current && !pickerAbort.current.signal.aborted)) return false;
    pickerAbort.current?.abort();
    const controller = new AbortController();
    pickerAbort.current = controller;
    setBusy(true);
    report.current('');
    try {
      let selection = await chatApi.selectWorkspace();
      while (selection.status === 'pending' && !controller.signal.aborted) {
        await new Promise(resolve => window.setTimeout(resolve, 700));
        selection = await chatApi.pollWorkspace(selection.requestId, controller.signal);
      }
      if (selection.status === 'selected' && selection.workspace) {
        const workspace = selection.workspace;
        setWorkspaces(current => [...current.filter(item => item.id !== workspace.id), workspace]);
        setSelected(workspace.id);
        return true;
      }
      if (!controller.signal.aborted) report.current('未选择目录，现有授权不受影响。');
      return false;
    } catch (cause) { if (!controller.signal.aborted) report.current(explain(cause, '目录选择失败')); return false; }
    finally {
      if (pickerAbort.current === controller) pickerAbort.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [busy]);

  const revoke = useCallback(async (id: string) => {
    setBusy(true);
    report.current('');
    try {
      await chatApi.revokeWorkspace(id);
      setWorkspaces(current => current.filter(item => item.id !== id));
      setSelected(current => current === id ? '' : current);
    } catch (cause) { report.current(explain(cause, '撤销工作区授权失败')); }
    finally { setBusy(false); }
  }, []);

  return { workspaces, globalCapabilities, selected, setSelected, busy, choose, revoke };
}
