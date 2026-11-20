import type { AgentTask } from './types.js';

export const professionalProfiles = {
  general: { name: '通用协作', instruction: '按任务选择必要工具，保留来源和可下载产物。', tools: null },
  document: { name: '文档助手', instruction: '先读取原文及来源，再组织文档；生成真实文件并复核中文和结构。', tools: ['document_', 'session_file_', 'files_archive', 'skill_'] },
  spreadsheet: { name: '表格助手', instruction: '保留数据类型、表名和公式；公式值未经重算时明确标注。生成真实XLSX并读取核验。', tools: ['document_', 'session_file_', 'files_archive', 'skill_'] },
  presentation: { name: '演示文稿助手', instruction: '先组织内容大纲，再生成PPTX；核对页数和文本。没有渲染证据不能声称排版无溢出。', tools: ['document_', 'session_file_', 'files_archive', 'skill_', 'image_'] },
  research: { name: '研究助手', instruction: '检索并保留实际URL、日期和来源。区分来源事实、推断和信息缺失，不编造引用。', tools: ['web_search', 'mcp_', 'session_file_', 'skill_'] },
  image: { name: '图像助手', instruction: '仅依据真正接收的图像输入分析；生成或编辑必须调用已配置工具并交付真实图像字节。', tools: ['image_', 'session_file_', 'files_archive', 'skill_'] },
} as const;
export function profileAllows(task: AgentTask, tool: string) {
  const profile = professionalProfiles[task.profileId ?? 'general'];
  return !profile.tools || profile.tools.some(prefix => tool.startsWith(prefix));
}
